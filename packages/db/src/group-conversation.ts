import type { MessageBlock } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  botMessageHopExhausted,
  isConversationalRun,
  mentionedMemberIds,
  messageReaction,
  nextBotMessageHop,
  QUEUE_HOLDING_RUN_STATUSES,
} from "@rakazo/core";
import type { Prisma } from "./client.js";

const CHAIN_NONCE_PREFIX = "group-chain:";
const MENTION_NONCE_PREFIX = "group-mention:";
const STEERABLE_RUN_STATUSES = new Set<string>(QUEUE_HOLDING_RUN_STATUSES);
const PERSON_MESSAGE_PAGE_SIZE = 20;

type Member = { id: string; name: string };

export type GroupConversationRun = { id: string; taskId: string; botId: string; status: string };

/** Nonce of a member's turn on a person's unaddressed message in a conversation group. */
export function groupChainRunNonce(messageId: string, botId: string): string {
  return `${CHAIN_NONCE_PREFIX}${messageId}:${botId}`;
}

function messageBlocks(message: { blocks: unknown } | null | undefined): MessageBlock[] {
  const blocks = message?.blocks;
  return Array.isArray(blocks) ? (blocks as MessageBlock[]) : [];
}

/** A person's own message, not an emoji reaction or a relayed channel post. */
function isPersonSend(message: { role: string; blocks: unknown; replyToMessageId: string | null }) {
  const blocks = messageBlocks(message);
  return (
    !blocks.some((block) => block.kind === "channel_message") &&
    !messageReaction({ role: message.role, blocks, replyToMessageId: message.replyToMessageId })
  );
}

// Reactions differ from sends only in sealed text, so the scan pages instead of filtering.
async function latestPersonMessage(tx: Prisma.TransactionClient, threadId: string) {
  let beforeSeq: number | undefined;
  for (;;) {
    const page = await tx.message.findMany({
      where: {
        threadId,
        role: "user",
        ...(beforeSeq === undefined ? {} : { seq: { lt: beforeSeq } }),
      },
      orderBy: { seq: "desc" },
      take: PERSON_MESSAGE_PAGE_SIZE,
      select: { id: true, seq: true, role: true, blocks: true, replyToMessageId: true },
    });
    const person = page.find(isPersonSend);
    if (person || page.length < PERSON_MESSAGE_PAGE_SIZE) return person;
    beforeSeq = page.at(-1)?.seq;
  }
}

/**
 * Lock a thread before a run in it ends, as `SELECT ... FOR UPDATE` does, and return its group's
 * id when that group is a live conversation, so no other thread needs a further read.
 */
export async function lockThreadForRunEnd(
  tx: Prisma.TransactionClient,
  threadId: string,
): Promise<string | null> {
  const [thread] = await tx.$queryRaw<Array<{ conversationGroupId: string | null }>>`
    SELECT g.id AS "conversationGroupId"
    FROM threads t
    LEFT JOIN chat_groups g
      ON g.id = t."groupId" AND g."conversationMode" AND g."archivedAt" IS NULL
    WHERE t.id = ${threadId}
    FOR UPDATE OF t
  `;
  return thread?.conversationGroupId ?? null;
}

/**
 * The bot-message hop that woke a group run: 0 for a person's message, the recorded hop for a
 * handoff, and one more than the posting run for a mention, so both share one budget.
 */
export async function groupRunHop(tx: Prisma.TransactionClient, runId: string): Promise<number> {
  const run = await tx.run.findUnique({
    where: { id: runId },
    select: { clientNonce: true, sourceMessage: { select: { runId: true, blocks: true } } },
  });
  const handoff = messageBlocks(run?.sourceMessage).find(
    (block): block is Extract<MessageBlock, { kind: "handoff" }> => block.kind === "handoff",
  );
  if (handoff) return handoff.hop ?? 0;
  const posterRunId = run?.clientNonce?.startsWith(MENTION_NONCE_PREFIX)
    ? run.sourceMessage?.runId
    : undefined;
  return posterRunId ? 1 + (await groupRunHop(tx, posterRunId)) : 0;
}

/**
 * Queue the next member's turn on a person's unaddressed message: the first member in order that
 * has not answered it, once no run started for it is still active. A member busy with older work
 * takes the message as steering, like a direct send, and the round moves past it. A run the person
 * stopped ends the round; an expired one, which records why, does not.
 */
export async function queueGroupConversationTurn(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    threadId: string;
    userId: string;
    members: readonly { id: string }[];
    source: { id: string; seq: number };
    prompt: string;
  },
): Promise<GroupConversationRun[]> {
  const { spaceId, threadId, userId, source } = input;
  const active = await tx.run.findMany({
    where: { threadId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: {
      id: true,
      botId: true,
      status: true,
      trigger: true,
      sourceMessage: { select: { seq: true } },
    },
  });
  if (active.some((run) => (run.sourceMessage?.seq ?? -1) >= source.seq)) return [];
  const [startedRuns, steered] = await Promise.all([
    tx.run.findMany({
      where: { threadId, sourceMessage: { seq: { gte: source.seq } } },
      select: { botId: true, status: true, error: true },
    }),
    tx.steeringMessage.findMany({ where: { messageId: source.id }, select: { botId: true } }),
  ]);
  const memberIds = new Set(input.members.map((member) => member.id));
  const stopped = startedRuns.some(
    (run) => run.status === "cancelled" && !run.error && memberIds.has(run.botId),
  );
  if (stopped) return [];
  const answered = new Set([...startedRuns, ...steered].map((row) => row.botId));
  for (const member of input.members) {
    if (answered.has(member.id)) continue;
    const busy = active.filter((run) => run.botId === member.id);
    if (busy.length > 0) {
      const steerable = busy.find(
        (run) => STEERABLE_RUN_STATUSES.has(run.status) && isConversationalRun(run.trigger),
      );
      await tx.steeringMessage.create({
        data: { messageId: source.id, botId: member.id, userId, runId: steerable?.id ?? null },
      });
      continue;
    }
    const task = await tx.task.create({
      data: { spaceId, botId: member.id, threadId, userId, prompt: input.prompt, status: "queued" },
    });
    const run = await tx.run.create({
      data: {
        spaceId,
        botId: member.id,
        threadId,
        taskId: task.id,
        userId,
        status: "queued",
        trigger: "user",
        clientNonce: groupChainRunNonce(source.id, member.id),
        sourceMessageId: source.id,
      },
    });
    return [run];
  }
  return [];
}

async function wakeMentionedMembers(
  tx: Prisma.TransactionClient,
  finished: { id: string; spaceId: string; threadId: string; botId: string; userId: string },
  members: Member[],
  message: { id: string; blocks: readonly MessageBlock[] },
): Promise<string[]> {
  const sender = members.find((member) => member.id === finished.botId);
  if (!sender) return [];
  const text = message.blocks
    .flatMap((block) => (block.kind === "text" ? [block.text] : []))
    .join("\n");
  const mentioned = mentionedMemberIds(text, members, sender.id);
  if (mentioned.length === 0) return [];
  if (botMessageHopExhausted(nextBotMessageHop(await groupRunHop(tx, finished.id)))) return [];
  const busy = await tx.run.findMany({
    where: {
      threadId: finished.threadId,
      botId: { in: mentioned },
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
    select: { botId: true },
  });
  const busyIds = new Set(busy.map((run) => run.botId));
  const runIds: string[] = [];
  for (const botId of mentioned) {
    // A member already working here reads the mention in the thread on its next turn.
    if (busyIds.has(botId)) continue;
    const clientNonce = `${MENTION_NONCE_PREFIX}${message.id}:${botId}`;
    const existing = await tx.run.findFirst({
      where: { spaceId: finished.spaceId, clientNonce },
      select: { id: true },
    });
    if (existing) continue;
    const task = await tx.task.create({
      data: {
        spaceId: finished.spaceId,
        botId,
        threadId: finished.threadId,
        userId: finished.userId,
        prompt: `[${sender.name} mentioned you]: ${text}`,
        status: "queued",
      },
    });
    const run = await tx.run.create({
      data: {
        spaceId: finished.spaceId,
        botId,
        threadId: finished.threadId,
        taskId: task.id,
        userId: finished.userId,
        status: "queued",
        trigger: "follow_up",
        sourceMessageId: message.id,
        clientNonce,
      },
    });
    runIds.push(run.id);
  }
  return runIds;
}

/**
 * After a run in a conversation group ends: wake the members its final reply mentions, then
 * continue the round on the person's latest unaddressed message. Returns the runs to enqueue.
 */
export async function advanceGroupConversation(
  tx: Prisma.TransactionClient,
  groupId: string,
  finishedRunId: string,
  postedMessage?: { id: string; blocks: readonly MessageBlock[] },
): Promise<string[]> {
  const finished = await tx.run.findUnique({
    where: { id: finishedRunId },
    select: {
      id: true,
      spaceId: true,
      threadId: true,
      botId: true,
      userId: true,
      sourceMessage: { select: { seq: true } },
    },
  });
  if (!finished) return [];
  const members = (
    await tx.chatGroupMember.findMany({
      where: { groupId, bot: { archivedAt: null } },
      orderBy: [{ createdAt: "asc" }, { botId: "asc" }],
      select: { bot: { select: { id: true, name: true } } },
    })
  ).map((member) => member.bot);
  const person = await latestPersonMessage(tx, finished.threadId);
  // A newer message from the person ends the replies to older ones.
  const stale = Boolean(
    person && finished.sourceMessage && finished.sourceMessage.seq < person.seq,
  );
  const mentionRunIds =
    postedMessage && !stale ? await wakeMentionedMembers(tx, finished, members, postedMessage) : [];
  if (!person) return mentionRunIds;
  const opener = await tx.run.findFirst({
    where: {
      threadId: finished.threadId,
      sourceMessageId: person.id,
      clientNonce: { startsWith: CHAIN_NONCE_PREFIX },
    },
    orderBy: { createdAt: "asc" },
    select: { userId: true, task: { select: { prompt: true } } },
  });
  if (!opener) return mentionRunIds;
  const turns = await queueGroupConversationTurn(tx, {
    spaceId: finished.spaceId,
    threadId: finished.threadId,
    userId: opener.userId,
    members,
    source: person,
    prompt: opener.task.prompt,
  });
  return [...mentionRunIds, ...turns.map((run) => run.id)];
}

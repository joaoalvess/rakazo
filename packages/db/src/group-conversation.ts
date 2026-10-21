import type { MessageBlock } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  groupConversationMaxChainMessages,
  groupConversationMaxMessagesPerHour,
  hasMentionToken,
  mentionedMemberIds,
} from "@rakazo/core";
import type { Prisma } from "./client.js";

const WAKE_NONCE_PREFIX = "group-wake:";
const CHAIN_PAUSE_NONCE_PREFIX = "group-pause:chain:";
const HOUR_PAUSE_NONCE_PREFIX = "group-pause:hour:";
const HOUR_MS = 60 * 60 * 1000;
/** Decisions that put a bot message in the thread and count toward the budgets. */
const POSTED_DECISIONS = ["speak", "handoff"];

type Member = { id: string; name: string };

export type GroupConversationDecision = "speak" | "wait" | "pass" | "handoff";

/** Runs a finish woke, and the system line to post when a budget paused the chain. */
export type GroupConversationWake = {
  runIds: string[];
  pause?: { clientNonce: string; text: string };
};

function messageText(blocks: unknown): string {
  return (Array.isArray(blocks) ? (blocks as MessageBlock[]) : [])
    .flatMap((block) => (block.kind === "text" ? [block.text] : []))
    .join("\n")
    .trim();
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

/** A run's chain: the one it was woken into, or the person's message it answers. */
function chainOf(run: {
  trigger: string;
  groupChainMessageId: string | null;
  sourceMessage: { id: string; role: string } | null;
}): string | null {
  if (run.groupChainMessageId) return run.groupChainMessageId;
  const answersPerson =
    run.sourceMessage?.role === "user" && (run.trigger === "user" || run.trigger === "follow_up");
  return answersPerson ? (run.sourceMessage?.id ?? null) : null;
}

const CHAIN_RUN_SELECT = {
  trigger: true,
  groupChainMessageId: true,
  sourceMessage: { select: { id: true, role: true } },
} as const;

/** The chain a running member's handoff continues, or null when it starts a new one. */
export async function groupRunChain(
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<string | null> {
  const run = await tx.run.findUnique({ where: { id: runId }, select: CHAIN_RUN_SELECT });
  return run ? chainOf(run) : null;
}

/**
 * The budget a bot message would exceed by waking members, if any. `pending` counts messages
 * not yet recorded, such as a handoff about to be posted; a null chain is one it would start.
 */
export async function exceededGroupConversationBudget(
  tx: Prisma.TransactionClient,
  input: { threadId: string; chainMessageId: string | null; now: Date; pending?: number },
): Promise<"chain" | "hour" | null> {
  const pending = input.pending ?? 0;
  const inChain = input.chainMessageId
    ? await tx.run.count({
        where: {
          threadId: input.threadId,
          groupChainMessageId: input.chainMessageId,
          conversationDecision: { in: POSTED_DECISIONS },
        },
      })
    : 0;
  if (inChain + pending >= groupConversationMaxChainMessages()) return "chain";
  const inHour = await tx.run.count({
    where: {
      threadId: input.threadId,
      conversationDecision: { in: POSTED_DECISIONS },
      completedAt: { gte: new Date(input.now.getTime() - HOUR_MS) },
    },
  });
  return inHour + pending >= groupConversationMaxMessagesPerHour() ? "hour" : null;
}

/** The pause line for a budget, once per chain or per hour window. */
async function pauseLine(
  tx: Prisma.TransactionClient,
  input: {
    threadId: string;
    budget: "chain" | "hour";
    chainMessageId: string;
    messageId: string;
    now: Date;
  },
): Promise<GroupConversationWake["pause"]> {
  if (input.budget === "chain") {
    const clientNonce = `${CHAIN_PAUSE_NONCE_PREFIX}${input.chainMessageId}`;
    const posted = await tx.message.findUnique({
      where: { threadId_clientNonce: { threadId: input.threadId, clientNonce } },
      select: { id: true },
    });
    if (posted) return undefined;
    return {
      clientNonce,
      text: `Bots paused this conversation after ${groupConversationMaxChainMessages()} messages. Send a message to continue.`,
    };
  }
  const posted = await tx.message.findFirst({
    where: {
      threadId: input.threadId,
      clientNonce: { startsWith: HOUR_PAUSE_NONCE_PREFIX },
      createdAt: { gte: new Date(input.now.getTime() - HOUR_MS) },
    },
    select: { id: true },
  });
  if (posted) return undefined;
  return {
    clientNonce: `${HOUR_PAUSE_NONCE_PREFIX}${input.messageId}`,
    text: `Bots paused after ${groupConversationMaxMessagesPerHour()} messages in the last hour. They reply to each other again as the hour clears.`,
  };
}

/**
 * Wake the candidates that still listen to a chain: not busy in the thread, and not passed in
 * this chain unless the message mentions them. Over a budget, nobody is woken.
 */
async function wakeMembers(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    threadId: string;
    userId: string;
    members: Member[];
    sender: Member;
    chainMessageId: string;
    message: { id: string; text: string };
    candidates: string[];
    now: Date;
  },
): Promise<GroupConversationWake> {
  const { threadId, candidates } = input;
  const [decided, busy] = await Promise.all([
    tx.run.findMany({
      where: {
        threadId,
        groupChainMessageId: input.chainMessageId,
        botId: { in: candidates },
        conversationDecision: { not: null },
      },
      orderBy: { createdAt: "desc" },
      select: { botId: true, conversationDecision: true },
    }),
    tx.run.findMany({
      where: { threadId, botId: { in: candidates }, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { botId: true },
    }),
  ]);
  const latest = new Map<string, string | null>();
  for (const run of decided)
    if (!latest.has(run.botId)) latest.set(run.botId, run.conversationDecision);
  const busyIds = new Set(busy.map((run) => run.botId));
  const mentioned = new Set(mentionedMemberIds(input.message.text, input.members, input.sender.id));
  const targets = candidates.filter(
    (botId) => !busyIds.has(botId) && (latest.get(botId) !== "pass" || mentioned.has(botId)),
  );
  if (targets.length === 0) return { runIds: [] };
  const budget = await exceededGroupConversationBudget(tx, {
    threadId,
    chainMessageId: input.chainMessageId,
    now: input.now,
  });
  if (budget) {
    return {
      runIds: [],
      pause: await pauseLine(tx, {
        threadId,
        budget,
        chainMessageId: input.chainMessageId,
        messageId: input.message.id,
        now: input.now,
      }),
    };
  }
  const runIds: string[] = [];
  for (const botId of targets) {
    const clientNonce = `${WAKE_NONCE_PREFIX}${input.message.id}:${botId}`;
    // A unique violation would abort the whole transaction, so look first.
    const existing = await tx.run.findFirst({
      where: { spaceId: input.spaceId, clientNonce },
      select: { id: true },
    });
    if (existing) continue;
    const task = await tx.task.create({
      data: {
        spaceId: input.spaceId,
        botId,
        threadId,
        userId: input.userId,
        prompt: `[${input.sender.name}]: ${input.message.text}`,
        status: "queued",
      },
    });
    const run = await tx.run.create({
      data: {
        spaceId: input.spaceId,
        botId,
        threadId,
        taskId: task.id,
        userId: input.userId,
        status: "queued",
        trigger: "follow_up",
        sourceMessageId: input.message.id,
        groupChainMessageId: input.chainMessageId,
        clientNonce,
      },
    });
    runIds.push(run.id);
  }
  return { runIds };
}

/**
 * Colleagues' replies posted after a member started its turn, which it may not have read: the
 * latest one when it waits, or the latest that mentions it otherwise.
 */
async function missedReply(
  tx: Prisma.TransactionClient,
  finished: { threadId: string; botId: string; since: Date; decision?: string },
  members: Member[],
): Promise<{
  sender: Member;
  chainMessageId: string;
  message: { id: string; text: string };
} | null> {
  const self = members.find((member) => member.id === finished.botId);
  if (!self) return null;
  const replies = await tx.run.findMany({
    where: {
      threadId: finished.threadId,
      botId: { in: members.filter((member) => member.id !== self.id).map((member) => member.id) },
      conversationDecision: "speak",
      completedAt: { gt: finished.since },
    },
    select: { id: true, botId: true, groupChainMessageId: true },
  });
  if (replies.length === 0) return null;
  const messages = await tx.message.findMany({
    where: {
      threadId: finished.threadId,
      role: "bot",
      runId: { in: replies.map((run) => run.id) },
    },
    orderBy: { seq: "desc" },
    select: { id: true, runId: true, blocks: true },
  });
  // A reply's final message is its run's last one; earlier ones were progress.
  const finals = messages.filter(
    (message, index) => messages.findIndex((other) => other.runId === message.runId) === index,
  );
  for (const message of finals) {
    const reply = replies.find((run) => run.id === message.runId);
    const sender = members.find((member) => member.id === reply?.botId);
    const text = messageText(message.blocks);
    if (!reply?.groupChainMessageId || !sender || !text) continue;
    if (finished.decision !== "wait" && !hasMentionToken(text, self.name)) continue;
    return { sender, chainMessageId: reply.groupChainMessageId, message: { id: message.id, text } };
  }
  return null;
}

/**
 * After a run in a conversation group completes: record its chain and decision, wake the members
 * still listening when it posted a reply, and hand it a colleague's reply it missed while busy.
 */
export async function advanceGroupConversation(
  tx: Prisma.TransactionClient,
  groupId: string,
  input: {
    runId: string;
    posted?: { id: string; blocks: readonly MessageBlock[] };
    decision?: "wait" | "pass";
    now: Date;
  },
): Promise<GroupConversationWake> {
  const finished = await tx.run.findUnique({
    where: { id: input.runId },
    select: {
      id: true,
      spaceId: true,
      threadId: true,
      botId: true,
      userId: true,
      createdAt: true,
      startedAt: true,
      ...CHAIN_RUN_SELECT,
    },
  });
  if (!finished) return { runIds: [] };
  const text = input.posted ? messageText(input.posted.blocks) : "";
  const chainMessageId = chainOf(finished) ?? (text ? (input.posted?.id ?? null) : null);
  const decision = text ? "speak" : input.decision;
  if (chainMessageId !== finished.groupChainMessageId || decision) {
    await tx.run.update({
      where: { id: finished.id },
      data: { groupChainMessageId: chainMessageId, conversationDecision: decision },
    });
  }
  const members = (
    await tx.chatGroupMember.findMany({
      where: { groupId, bot: { archivedAt: null } },
      orderBy: [{ createdAt: "asc" }, { botId: "asc" }],
      select: { bot: { select: { id: true, name: true } } },
    })
  ).map((member) => member.bot);
  const sender = members.find((member) => member.id === finished.botId);
  if (!sender) return { runIds: [] };
  const base = {
    spaceId: finished.spaceId,
    threadId: finished.threadId,
    userId: finished.userId,
    members,
    now: input.now,
  };
  const woken: GroupConversationWake =
    text && input.posted && chainMessageId
      ? await wakeMembers(tx, {
          ...base,
          sender,
          chainMessageId,
          message: { id: input.posted.id, text },
          candidates: members
            .filter((member) => member.id !== sender.id)
            .map((member) => member.id),
        })
      : { runIds: [] };
  const missed = await missedReply(
    tx,
    {
      threadId: finished.threadId,
      botId: finished.botId,
      since: finished.startedAt ?? finished.createdAt,
      decision,
    },
    members,
  );
  if (!missed) return woken;
  const again = await wakeMembers(tx, { ...base, ...missed, candidates: [sender.id] });
  return { runIds: [...woken.runIds, ...again.runIds], pause: woken.pause ?? again.pause };
}

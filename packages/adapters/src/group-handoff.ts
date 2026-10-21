import { runContinueJob } from "@rakazo/adapter-kit";
import { MessageBlock } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  botMessageHopExhausted,
  hasMentionToken,
  nextBotMessageHop,
  renderGroupMembersContext,
} from "@rakazo/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  exceededGroupConversationBudget,
  groupRunChain,
  IsolationError,
  lockOwnedGroup,
  type PrismaClient,
  touchGroupUpdatedAt,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor.js";

export async function handoffToGroupBot(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
  },
  groupId: string,
  input: { bot_id?: string; confirm_name?: string; message: string },
) {
  const deliveryKey = `group-handoff:${run.id}`;
  const committed = await deps.prisma.$transaction(async (tx) => {
    try {
      await lockOwnedGroup(tx, run, groupId);
    } catch (error) {
      if (error instanceof IsolationError)
        return { error: "group is no longer available" } as const;
      throw error;
    }
    const [group, activeSource] = await Promise.all([
      tx.chatGroup.findFirst({
        where: { id: groupId, archivedAt: null, thread: { id: run.threadId } },
        include: {
          members: {
            where: { bot: { archivedAt: null } },
            include: { bot: { select: { id: true, name: true } } },
            orderBy: { createdAt: "asc" },
          },
        },
      }),
      tx.run.findFirst({
        where: {
          id: run.id,
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          userId: run.userId,
          status: "running",
        },
        select: { id: true, sourceMessage: { select: { blocks: true } } },
      }),
    ]);
    if (!group || !activeSource) return { error: "source run is no longer active" } as const;
    if (!group.members.some((member) => member.bot.id === run.botId)) {
      return { error: "source bot is no longer a group member" } as const;
    }

    const existing = await tx.message.findUnique({
      where: { threadId_clientNonce: { threadId: run.threadId, clientNonce: deliveryKey } },
      select: {
        sourceRuns: {
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { id: true, botId: true },
        },
      },
    });
    if (existing) {
      const nextRun = existing.sourceRuns[0];
      const event = await tx.event.findFirst({
        where: { threadId: run.threadId, runId: run.id, type: "group.handoff" },
        orderBy: { seq: "desc" },
        select: { seq: true },
      });
      if (!nextRun || !event) return { error: "recorded handoff is incomplete" } as const;
      return { ok: true, botId: nextRun.botId, runId: nextRun.id, eventSeq: event.seq } as const;
    }

    let targetId = input.bot_id?.trim();
    if (!targetId && input.confirm_name?.trim()) {
      const name = input.confirm_name.trim().toLowerCase();
      targetId = group.members.find((member) => member.bot.name.toLowerCase() === name)?.bot.id;
    }
    if (!targetId) return { error: "handoff target bot is required" } as const;
    if (targetId === run.botId) return { error: "cannot hand off to yourself" } as const;
    if (!group.members.some((member) => member.bot.id === targetId)) {
      return { error: "handoff target is not a group member" } as const;
    }

    let sourceBlocks: MessageBlock[] = [];
    if (activeSource.sourceMessage) {
      const parsedSource = MessageBlock.array().safeParse(activeSource.sourceMessage.blocks);
      if (!parsedSource.success) {
        return { error: "cannot verify the group handoff chain" } as const;
      }
      sourceBlocks = parsedSource.data;
    }
    const sourceHandoff = sourceBlocks.find(
      (block): block is Extract<MessageBlock, { kind: "handoff" }> => block.kind === "handoff",
    );
    if (sourceHandoff?.fromBotId === targetId) {
      return {
        error:
          "do not hand this stage back to its sender; post the result in the shared thread instead",
      } as const;
    }
    const hop = nextBotMessageHop(sourceHandoff?.hop);
    // A conversation group's budgets replace the hop cap, so replies and handoffs share them.
    const chainMessageId = group.conversationMode ? await groupRunChain(tx, run.id) : null;
    if (group.conversationMode) {
      const busy = await tx.run.findFirst({
        where: {
          threadId: run.threadId,
          botId: targetId,
          status: { in: [...ACTIVE_RUN_STATUSES] },
        },
        select: { id: true },
      });
      if (busy) {
        return {
          error: "that member is already working in this thread; mention it in your reply instead",
        } as const;
      }
    }
    const exhausted = group.conversationMode
      ? (await exceededGroupConversationBudget(tx, {
          threadId: run.threadId,
          chainMessageId,
          now: new Date(),
          pending: 1,
        })) !== null
      : botMessageHopExhausted(hop);
    if (exhausted) {
      return {
        error:
          "group handoff limit reached for this chain; finish the current stage in the shared thread instead",
      } as const;
    }

    const handoffBlock: MessageBlock = {
      kind: "handoff",
      fromBotId: run.botId,
      toBotId: targetId,
      text: input.message,
      hop,
    };
    const message = await createThreadMessageInTransaction(tx, {
      threadId: run.threadId,
      role: "bot",
      blocks: [handoffBlock],
      botId: run.botId,
      runId: run.id,
      clientNonce: deliveryKey,
    });
    const task = await tx.task.create({
      data: {
        spaceId: run.spaceId,
        botId: targetId,
        threadId: run.threadId,
        userId: run.userId,
        prompt: input.message,
        status: "queued",
      },
    });
    const nextRun = await tx.run.create({
      data: {
        spaceId: run.spaceId,
        botId: targetId,
        threadId: run.threadId,
        taskId: task.id,
        userId: run.userId,
        status: "queued",
        trigger: "follow_up",
        sourceMessageId: message.id,
        groupChainMessageId: group.conversationMode ? (chainMessageId ?? message.id) : undefined,
      },
    });
    if (group.conversationMode) {
      await tx.run.update({
        where: { id: run.id },
        data: {
          groupChainMessageId: chainMessageId ?? message.id,
          conversationDecision: "handoff",
        },
      });
    }
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      type: "group.handoff",
      runId: run.id,
      payload: {
        messageId: message.id,
        fromBotId: run.botId,
        toBotId: targetId,
        text: input.message,
      },
    });
    await touchGroupUpdatedAt(tx, groupId);
    return { ok: true, botId: targetId, runId: nextRun.id, eventSeq: event.seq } as const;
  });
  if ("error" in committed) return committed;
  await deps.events.notify(run.threadId, committed.eventSeq).catch((error) => {
    getLogger().error("group handoff realtime notification", error);
  });
  await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
    // The queued run is durable and the job reconciler will repair a missed immediate wake.
    getLogger().error("group handoff enqueue", error);
  });
  return {
    ok: true,
    botId: committed.botId,
    runId: committed.runId,
    note: "Handoff recorded. End this turn without narrating it; the next bot owns the next stage.",
  };
}

export async function loadGroupContext(
  prisma: PrismaClient,
  groupId: string,
  self: { id: string; name: string },
): Promise<{ context: string; conversationMode: boolean } | undefined> {
  const group = await prisma.chatGroup.findUnique({
    where: { id: groupId },
    include: {
      members: {
        where: { bot: { archivedAt: null } },
        include: {
          bot: { select: { id: true, name: true, title: true, description: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!group) return undefined;
  return {
    context: renderGroupMembersContext(
      group.name,
      group.members.map((member) => member.bot),
      self,
      { conversationMode: group.conversationMode },
    ),
    conversationMode: group.conversationMode,
  };
}

/**
 * In a conversation group, a member may stay silent unless a person named it or a colleague
 * handed it a stage. A colleague's mention allows silence, so a thank-you needs no reply.
 */
export function groupConversationAllowsSilence(
  source: { role: string; blocks: readonly MessageBlock[] } | undefined,
  self: { id: string; name: string },
): boolean {
  if (!source) return false;
  return !source.blocks.some((block) =>
    block.kind === "handoff"
      ? block.toBotId === self.id
      : source.role === "user" && block.kind === "text" && hasMentionToken(block.text, self.name),
  );
}

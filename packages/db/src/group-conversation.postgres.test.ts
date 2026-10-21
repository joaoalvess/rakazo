import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { finalizeRun } from "./events.js";
import { expireStuckRun } from "./expire-stuck-run.js";
import { groupChainRunNonce } from "./group-conversation.js";
import { createGroupRepos } from "./groups.js";
import { createThreadMessage } from "./messages.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { createRepos } from "./repos.js";
import { runAsSystem } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

const fixture = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);

describePostgres("conversation groups (PostgreSQL)", () => {
  const provider = "sendblue";
  const address = `+1556${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let owner: { userId: string; spaceId: string };
  let groupId: string;
  let threadId: string;
  let ada: { id: string };
  let ben: { id: string };
  let cy: { id: string };

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      try {
        await db.prisma.$disconnect();
      } finally {
        await db.pool.end();
      }
    };
    owner = await fixture(() =>
      provisionMessagingIdentity(
        prisma,
        { provider, address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    const actor = { ...owner, email: "conversation@example.test", isDeploymentOwner: false };
    const bot = (name: string) =>
      createRepos(prisma).createBot(actor, {
        name,
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: true,
      });
    [ada, ben, cy] = await fixture(async () => [
      await bot("Ada"),
      await bot("Ben"),
      await bot("Cy"),
    ]);
    const group = await fixture(() =>
      createGroupRepos(prisma).createGroup(actor, {
        name: "Crew",
        botIds: [ada.id, ben.id, cy.id],
        conversationMode: true,
      }),
    );
    groupId = group.id;
    threadId = group.threadId;
  });

  afterEach(async () => {
    delete process.env.BOT_MESSAGE_MAX_HOPS;
    await fixture(async () => {
      await prisma.run.updateMany({
        where: { threadId, status: { in: ["queued", "running", "waiting_input"] } },
        data: { status: "cancelled" },
      });
      await prisma.chatGroup.update({ where: { id: groupId }, data: { conversationMode: true } });
    });
  });

  afterAll(async () => {
    try {
      if (prisma && owner) {
        await fixture(async () => {
          await prisma.messagingIdentity.deleteMany({ where: { provider, address } });
          await prisma.chatGroup.deleteMany({ where: { spaceId: owner.spaceId } });
          await prisma.bot.deleteMany({ where: { spaceId: owner.spaceId } });
          await prisma.organization.deleteMany({ where: { id: owner.spaceId } });
          await prisma.user.deleteMany({ where: { id: owner.userId } });
        });
      }
    } finally {
      await close?.();
    }
  });

  const personSays = (text: string, replyToMessageId?: string) =>
    createThreadMessage(prisma, {
      threadId,
      role: "user",
      blocks: [{ kind: "text", text }],
      replyToMessageId,
    });

  async function queueRun(
    botId: string,
    input: { prompt: string; clientNonce?: string; sourceMessageId?: string },
  ) {
    const { spaceId, userId } = owner;
    const task = await prisma.task.create({
      data: { spaceId, botId, threadId, userId, prompt: input.prompt, status: "queued" },
    });
    return prisma.run.create({
      data: {
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        userId,
        status: "queued",
        trigger: "user",
        clientNonce: input.clientNonce,
        sourceMessageId: input.sourceMessageId,
      },
    });
  }

  /** The first member's turn, as the send path queues it for an unaddressed message. */
  const openRound = (message: { id: string }, prompt: string) =>
    queueRun(ada.id, {
      prompt,
      clientNonce: groupChainRunNonce(message.id, ada.id),
      sourceMessageId: message.id,
    });

  async function finish(runId: string, outcome: { text: string } | { error: string }) {
    const run = await prisma.run.update({
      where: { id: runId },
      data: { status: "running", startedAt: new Date(), leaseOwner: "worker-1", leaseFence: 1 },
    });
    const attempt = await prisma.attempt.create({ data: { runId, fence: 1, status: "running" } });
    const base = {
      spaceId: owner.spaceId,
      threadId,
      botId: run.botId,
      runId,
      taskId: run.taskId,
      attemptId: attempt.id,
      leaseOwner: "worker-1",
      leaseFence: 1,
    };
    const result = await finalizeRun(
      prisma,
      "text" in outcome
        ? { ...base, outcome: "completed", blocks: [{ kind: "text", text: outcome.text }] }
        : { ...base, outcome: "failed", error: outcome.error },
    );
    if (!result) throw new Error("Run did not finalize");
    return result.nextRunIds ?? [];
  }

  const turn = (runId: string) =>
    prisma.run.findUniqueOrThrow({
      where: { id: runId },
      select: {
        botId: true,
        trigger: true,
        clientNonce: true,
        sourceMessageId: true,
        task: { select: { prompt: true } },
      },
    });

  it("gives every member a turn on an unaddressed message, one after another", () =>
    fixture(async () => {
      const message = await personSays("What should we build next?");
      const opener = await openRound(message, "What should we build next?");

      const [benTurn, ...rest] = await finish(opener.id, { text: "A faster search." });
      expect(rest).toEqual([]);
      await expect(turn(benTurn!)).resolves.toEqual({
        botId: ben.id,
        trigger: "user",
        clientNonce: groupChainRunNonce(message.id, ben.id),
        sourceMessageId: message.id,
        task: { prompt: "What should we build next?" },
      });

      const [cyTurn] = await finish(benTurn!, { error: "model unavailable" });
      await expect(turn(cyTurn!)).resolves.toMatchObject({
        botId: cy.id,
        clientNonce: groupChainRunNonce(message.id, cy.id),
      });

      await expect(finish(cyTurn!, { text: "Agreed." })).resolves.toEqual([]);
    }));

  it("ignores a reaction but stops the round when the person writes again", () =>
    fixture(async () => {
      const message = await personSays("Thoughts on the launch?");
      const opener = await openRound(message, "Thoughts on the launch?");
      const [benTurn] = await finish(opener.id, { text: "Ship it on Monday." });
      const reply = await prisma.message.findFirstOrThrow({ where: { runId: opener.id } });
      await personSays("👍", reply.id);

      const [cyTurn] = await finish(benTurn!, { text: "Monday works." });
      await expect(turn(cyTurn!)).resolves.toMatchObject({ botId: cy.id });

      await personSays("Actually, let's wait.");
      await expect(finish(cyTurn!, { text: "Sure, @Ada can plan it." })).resolves.toEqual([]);
    }));

  it("wakes the members a reply mentions until the hop budget runs out", () =>
    fixture(async () => {
      process.env.BOT_MESSAGE_MAX_HOPS = "2";
      const message = await personSays("Can someone check the numbers?");
      const opener = await openRound(message, "Can someone check the numbers?");

      const [benMention, ...rest] = await finish(opener.id, { text: "@Ben can you check?" });
      expect(rest).toEqual([]);
      const adaReply = await prisma.message.findFirstOrThrow({ where: { runId: opener.id } });
      await expect(turn(benMention!)).resolves.toEqual({
        botId: ben.id,
        trigger: "follow_up",
        clientNonce: `group-mention:${adaReply.id}:${ben.id}`,
        sourceMessageId: adaReply.id,
        task: { prompt: "[Ada mentioned you]: @Ben can you check?" },
      });

      const [adaMention] = await finish(benMention!, { text: "@Ada they add up." });
      await expect(turn(adaMention!)).resolves.toMatchObject({ botId: ada.id });

      const [cyTurn, ...after] = await finish(adaMention!, { text: "Thanks @Ben" });
      expect(after).toEqual([]);
      await expect(turn(cyTurn!)).resolves.toMatchObject({
        botId: cy.id,
        clientNonce: groupChainRunNonce(message.id, cy.id),
      });
    }));

  it("steers a member still busy with older work and moves on to the next one", () =>
    fixture(async () => {
      const earlier = await personSays("@Ben run the report");
      const busy = await queueRun(ben.id, {
        prompt: "run the report",
        sourceMessageId: earlier.id,
      });
      await prisma.run.update({ where: { id: busy.id }, data: { status: "running" } });
      const message = await personSays("Anyone around?");
      const opener = await openRound(message, "Anyone around?");

      const [cyTurn, ...rest] = await finish(opener.id, { text: "I am." });

      expect(rest).toEqual([]);
      await expect(turn(cyTurn!)).resolves.toMatchObject({ botId: cy.id });
      await expect(
        prisma.steeringMessage.findMany({
          where: { messageId: message.id },
          select: { botId: true, runId: true },
        }),
      ).resolves.toEqual([{ botId: ben.id, runId: busy.id }]);
    }));

  it("moves on when a member's wait for input expires", () =>
    fixture(async () => {
      const message = await personSays("Who can help?");
      const opener = await openRound(message, "Who can help?");
      const waiting = await prisma.run.update({
        where: { id: opener.id },
        data: { status: "waiting_input" },
      });

      const expired = await prisma.$transaction((tx) =>
        expireStuckRun(tx, {
          runId: opener.id,
          threadId,
          status: "waiting_input",
          updatedAt: waiting.updatedAt,
          now: new Date(),
        }),
      );

      expect(expired?.nextRunIds).toHaveLength(1);
      await expect(turn(expired!.nextRunIds![0]!)).resolves.toMatchObject({ botId: ben.id });
    }));

  it("queues nothing when the group is not in conversation mode", () =>
    fixture(async () => {
      await prisma.chatGroup.update({ where: { id: groupId }, data: { conversationMode: false } });
      const message = await personSays("Hello?");
      const opener = await queueRun(ada.id, { prompt: "Hello?", sourceMessageId: message.id });

      await expect(finish(opener.id, { text: "Hi. @Ben say hi" })).resolves.toEqual([]);
      expect(await prisma.run.count({ where: { threadId, status: "queued" } })).toBe(0);
    }));
});

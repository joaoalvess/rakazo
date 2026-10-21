import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { finalizeRun } from "./events.js";
import { createGroupRepos } from "./groups.js";
import { createThreadMessage } from "./messages.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { createRepos } from "./repos.js";
import { runAsSystem } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

const fixture = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);

type Outcome = { text: string } | { decision: "wait" | "pass" } | { error: string };

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
    delete process.env.GROUP_CONVERSATION_MAX_CHAIN_MESSAGES;
    delete process.env.GROUP_CONVERSATION_MAX_MESSAGES_PER_HOUR;
    await fixture(async () => {
      await prisma.run.updateMany({
        where: { threadId, status: { in: ["queued", "running", "waiting_input"] } },
        data: { status: "cancelled" },
      });
      await prisma.chatGroup.update({
        where: { id: groupId },
        data: { conversationMode: true, archivedAt: null },
      });
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

  const personSays = (text: string) =>
    createThreadMessage(prisma, { threadId, role: "user", blocks: [{ kind: "text", text }] });

  async function queueRun(
    botId: string,
    input: { prompt: string; trigger?: string; sourceMessageId?: string; chain?: string },
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
        trigger: input.trigger ?? "user",
        sourceMessageId: input.sourceMessageId,
        groupChainMessageId: input.chain,
      },
    });
  }

  /** Every member's run on a person's message, as the send path queues them. */
  async function wakeEveryone(message: { id: string }, prompt: string) {
    const runs = [];
    for (const member of [ada, ben, cy]) {
      const run = await queueRun(member.id, {
        prompt,
        sourceMessageId: message.id,
        chain: message.id,
      });
      await start(run.id);
      runs.push(run);
    }
    return runs;
  }

  const start = (runId: string) =>
    prisma.run.update({
      where: { id: runId },
      data: { status: "running", startedAt: new Date(), leaseOwner: "worker-1", leaseFence: 1 },
    });

  async function finish(runId: string, outcome: Outcome) {
    const current = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    const run = current.status === "running" ? current : await start(runId);
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
      "error" in outcome
        ? { ...base, outcome: "failed", error: outcome.error }
        : "text" in outcome
          ? { ...base, outcome: "completed", blocks: [{ kind: "text", text: outcome.text }] }
          : { ...base, outcome: "completed", blocks: [], conversationDecision: outcome.decision },
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
        sourceMessageId: true,
        groupChainMessageId: true,
        conversationDecision: true,
        task: { select: { prompt: true } },
      },
    });
  const replyOf = (runId: string) =>
    prisma.message.findFirstOrThrow({ where: { runId, role: "bot" }, orderBy: { seq: "desc" } });
  const pauseLines = () =>
    prisma.message.findMany({
      where: { threadId, role: "system", clientNonce: { startsWith: "group-pause:" } },
      orderBy: { seq: "asc" },
    });

  it("wakes the members still listening, keeps a pass out, and lets a wait hear the reply", () =>
    fixture(async () => {
      const question = await personSays("What should we build next?");
      const [adaRun, benRun, cyRun] = await wakeEveryone(question, "What should we build next?");

      await expect(finish(benRun!.id, { decision: "pass" })).resolves.toEqual([]);
      // Cy is still deciding, so Ada's reply wakes nobody yet.
      await expect(finish(adaRun!.id, { text: "A faster search." })).resolves.toEqual([]);
      const [cyAgain, ...rest] = await finish(cyRun!.id, { decision: "wait" });
      expect(rest).toEqual([]);
      const adaReply = await replyOf(adaRun!.id);
      await expect(turn(cyAgain!)).resolves.toEqual({
        botId: cy.id,
        trigger: "follow_up",
        sourceMessageId: adaReply.id,
        groupChainMessageId: question.id,
        conversationDecision: null,
        task: { prompt: "[Ada]: A faster search." },
      });

      const [adaAgain, ...others] = await finish(cyAgain!, { text: "Search by tag as well." });
      expect(others).toEqual([]);
      await expect(turn(adaAgain!)).resolves.toMatchObject({ botId: ada.id });
      await expect(finish(adaAgain!, { decision: "pass" })).resolves.toEqual([]);

      const decisions = await prisma.run.findMany({
        where: { groupChainMessageId: question.id },
        orderBy: { createdAt: "asc" },
        select: { botId: true, conversationDecision: true },
      });
      expect(decisions.map((run) => [run.botId, run.conversationDecision])).toEqual([
        [ada.id, "speak"],
        [ben.id, "pass"],
        [cy.id, "wait"],
        [cy.id, "speak"],
        [ada.id, "pass"],
      ]);
    }));

  it("wakes a waiting member with the next reply once it is free", () =>
    fixture(async () => {
      const question = await personSays("Where should the offsite be?");
      const [adaRun, benRun, cyRun] = await wakeEveryone(question, "Where should the offsite be?");

      await expect(finish(cyRun!.id, { decision: "wait" })).resolves.toEqual([]);
      await expect(finish(benRun!.id, { decision: "pass" })).resolves.toEqual([]);
      const [cyAgain, ...rest] = await finish(adaRun!.id, { text: "Lisbon in May." });

      expect(rest).toEqual([]);
      await expect(turn(cyAgain!)).resolves.toMatchObject({ botId: cy.id, trigger: "follow_up" });
    }));

  it("wakes a member that passed when a colleague mentions it, even while it was busy", () =>
    fixture(async () => {
      const question = await personSays("Is the report ready?");
      const [adaRun, benRun, cyRun] = await wakeEveryone(question, "Is the report ready?");

      await expect(finish(cyRun!.id, { decision: "pass" })).resolves.toEqual([]);
      // Ben is still busy, so the mention reaches him when he finishes.
      await expect(
        finish(adaRun!.id, { text: "@Ben can you check the numbers?" }),
      ).resolves.toEqual([]);
      const woken = await finish(benRun!.id, { text: "The report is ready." });
      const runs = await Promise.all(woken.map(turn));
      const adaReply = await replyOf(adaRun!.id);
      const benReply = await replyOf(benRun!.id);
      expect(runs.map((run) => [run.botId, run.sourceMessageId])).toEqual([
        [ada.id, benReply.id],
        [ben.id, adaReply.id],
      ]);

      await expect(finish(woken[1]!, { decision: "pass" })).resolves.toEqual([]);
      const [cyMention, ...rest] = await finish(woken[0]!, { text: "Thanks, @Cy please file it." });
      expect(rest).toEqual([]);
      await expect(turn(cyMention!)).resolves.toMatchObject({ botId: cy.id });
    }));

  it("starts a chain from a routine's reply in the group", () =>
    fixture(async () => {
      const routineRun = await queueRun(cy.id, {
        prompt: "post the morning summary",
        trigger: "routine",
      });

      const woken = await finish(routineRun.id, { text: "Morning summary: two deploys today." });

      const reply = await replyOf(routineRun.id);
      await expect(turn(routineRun.id)).resolves.toMatchObject({
        groupChainMessageId: reply.id,
        conversationDecision: "speak",
      });
      const runs = await Promise.all(woken.map(turn));
      expect(runs.map((run) => [run.botId, run.groupChainMessageId])).toEqual([
        [ada.id, reply.id],
        [ben.id, reply.id],
      ]);
    }));

  it("pauses a chain at its budget with one line and no model run", () =>
    fixture(async () => {
      process.env.GROUP_CONVERSATION_MAX_CHAIN_MESSAGES = "2";
      const before = (await pauseLines()).length;
      const question = await personSays("Ping pong?");
      const [adaRun, benRun, cyRun] = await wakeEveryone(question, "Ping pong?");
      await finish(cyRun!.id, { decision: "pass" });
      await finish(benRun!.id, { decision: "wait" });

      const [benAgain] = await finish(adaRun!.id, { text: "Ping." });
      await expect(finish(benAgain!, { text: "Pong." })).resolves.toEqual([]);
      const late = await queueRun(ada.id, {
        prompt: "late",
        trigger: "follow_up",
        chain: question.id,
      });
      await expect(finish(late.id, { text: "Ping again." })).resolves.toEqual([]);

      const lines = (await pauseLines()).slice(before);
      expect(lines.map((line) => [line.clientNonce, line.blocks])).toEqual([
        [
          `group-pause:chain:${question.id}`,
          [
            {
              kind: "meta",
              text: "Bots paused this conversation after 2 messages. Send a message to continue.",
            },
          ],
        ],
      ]);
      expect(await prisma.run.count({ where: { threadId, status: "queued" } })).toBe(0);
    }));

  it("pauses the group once per hour across chains", () =>
    fixture(async () => {
      const posted = await prisma.run.count({
        where: {
          threadId,
          conversationDecision: { in: ["speak", "handoff"] },
          completedAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
        },
      });
      process.env.GROUP_CONVERSATION_MAX_MESSAGES_PER_HOUR = String(posted + 1);
      const before = (await pauseLines()).length;

      const first = await queueRun(ada.id, { prompt: "status", trigger: "routine" });
      await expect(finish(first.id, { text: "Status: green." })).resolves.toEqual([]);
      const second = await queueRun(ben.id, { prompt: "status", trigger: "routine" });
      await expect(finish(second.id, { text: "Status: still green." })).resolves.toEqual([]);

      const lines = (await pauseLines()).slice(before);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.blocks).toEqual([
        {
          kind: "meta",
          text: `Bots paused after ${posted + 1} messages in the last hour. They reply to each other again as the hour clears.`,
        },
      ]);
    }));

  it("answers a person who named a busy member once it stays silent", () =>
    fixture(async () => {
      const question = await personSays("Who has the numbers?");
      const [adaRun, benRun, cyRun] = await wakeEveryone(question, "Who has the numbers?");
      await finish(adaRun!.id, { decision: "pass" });
      await finish(cyRun!.id, { decision: "pass" });
      // Ben read both while he worked, as claimSteering records it.
      const named = await personSays("@Ben status?");
      const aside = await personSays("Anyone around?");
      for (const message of [named, aside]) {
        await prisma.steeringMessage.create({
          data: {
            messageId: message.id,
            botId: ben.id,
            userId: owner.userId,
            runId: benRun!.id,
            claimedAt: new Date(),
          },
        });
      }

      await finish(benRun!.id, { decision: "wait" });

      expect(
        await prisma.run.findMany({
          where: { threadId, botId: ben.id, status: "queued" },
          select: { trigger: true, sourceMessageId: true },
        }),
      ).toEqual([{ trigger: "follow_up", sourceMessageId: named.id }]);
    }));

  it("never repeats an hourly pause line when it hands over a reply it paused on", () =>
    fixture(async () => {
      const hourAgo = (offset: number) => new Date(Date.now() - 60 * 60 * 1000 - offset);
      await prisma.message.updateMany({
        where: { threadId, clientNonce: { startsWith: "group-pause:hour:" } },
        data: { createdAt: hourAgo(60_000) },
      });
      const question = await personSays("Late night?");
      const [adaRun, benRun, cyRun] = await wakeEveryone(question, "Late night?");
      await finish(cyRun!.id, { decision: "wait" });
      const posted = await prisma.run.count({
        where: {
          threadId,
          conversationDecision: { in: ["speak", "handoff"] },
          completedAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
        },
      });
      process.env.GROUP_CONVERSATION_MAX_MESSAGES_PER_HOUR = String(posted + 1);

      await expect(finish(adaRun!.id, { text: "Still up." })).resolves.toEqual([]);
      const adaReply = await replyOf(adaRun!.id);
      const [line] = (await pauseLines()).slice(-1);
      expect(line?.clientNonce).toBe(`group-pause:hour:${adaReply.id}`);
      // A run that outlived the hour is handed the same reply over the budget again.
      await prisma.message.update({ where: { id: line!.id }, data: { createdAt: hourAgo(0) } });
      const before = (await pauseLines()).length;

      await expect(finish(benRun!.id, { decision: "wait" })).resolves.toEqual([]);
      expect(await pauseLines()).toHaveLength(before);
    }));

  it("records nothing and wakes nobody outside a live conversation group", () =>
    fixture(async () => {
      await prisma.chatGroup.update({ where: { id: groupId }, data: { conversationMode: false } });
      const hello = await personSays("Hello?");
      const off = await queueRun(ada.id, { prompt: "Hello?", sourceMessageId: hello.id });
      await expect(finish(off.id, { text: "Hi. @Ben say hi" })).resolves.toEqual([]);
      await expect(turn(off.id)).resolves.toMatchObject({
        groupChainMessageId: null,
        conversationDecision: null,
      });

      await prisma.chatGroup.update({
        where: { id: groupId },
        data: { conversationMode: true, archivedAt: new Date() },
      });
      const archived = await queueRun(ada.id, { prompt: "Hello?", sourceMessageId: hello.id });
      await expect(finish(archived.id, { text: "Still here. @Ben" })).resolves.toEqual([]);
      expect(await prisma.run.count({ where: { threadId, status: "queued" } })).toBe(0);
    }));

  it("wakes nobody when a member's run fails", () =>
    fixture(async () => {
      const question = await personSays("Anyone?");
      const [adaRun] = await wakeEveryone(question, "Anyone?");
      await expect(finish(adaRun!.id, { error: "model unavailable" })).resolves.toEqual([]);
    }));
});

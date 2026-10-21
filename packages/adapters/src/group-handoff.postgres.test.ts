import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  createDb,
  createGroupRepos,
  createRepos,
  createThreadEvents,
  createThreadMessage,
  provisionMessagingIdentity,
  runAsSystem,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { handoffToGroupBot } from "./group-handoff.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

const fixture = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);

describePostgres("conversation group handoffs (PostgreSQL)", () => {
  const provider = "sendblue";
  const address = `+1557${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let owner: { userId: string; spaceId: string };
  let groupId: string;
  let threadId: string;
  let ada: { id: string };
  let ben: { id: string };

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
    const actor = { ...owner, email: "handoff@example.test", isDeploymentOwner: false };
    const bot = (name: string) =>
      createRepos(prisma).createBot(actor, {
        name,
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: true,
      });
    [ada, ben] = await fixture(async () => [await bot("Ada"), await bot("Ben")]);
    const group = await fixture(() =>
      createGroupRepos(prisma).createGroup(actor, {
        name: "Crew",
        botIds: [ada.id, ben.id],
        conversationMode: true,
      }),
    );
    groupId = group.id;
    threadId = group.threadId;
  });

  afterEach(() =>
    fixture(() =>
      prisma.run.updateMany({
        where: { threadId, status: { in: [...ACTIVE_RUN_STATUSES] } },
        data: { status: "cancelled" },
      }),
    ),
  );

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

  async function queueRun(
    tx: Prisma.TransactionClient,
    botId: string,
    question: { id: string },
    status = "queued",
  ) {
    const { spaceId, userId } = owner;
    const task = await tx.task.create({
      data: { spaceId, botId, threadId, userId, prompt: "Plan the launch", status },
    });
    return tx.run.create({
      data: {
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        userId,
        status,
        trigger: "user",
        sourceMessageId: question.id,
        groupChainMessageId: question.id,
        startedAt: status === "running" ? new Date() : undefined,
      },
    });
  }

  /** Hold the thread row, as a finishing run or Stop does, until `release`, then run `work`. */
  function holdThread(work: (tx: Prisma.TransactionClient) => Promise<unknown>) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const held = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const done = fixture(() =>
      prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
          locked();
          await released;
          await work(tx);
        },
        { timeout: 20_000 },
      ),
    );
    return { held, release, done };
  }

  async function untilWaitingOnALock() {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const [row] = await fixture(
        () => prisma.$queryRaw<Array<{ waiting: number }>>`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
        `,
      );
      if ((row?.waiting ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("the handoff never waited on a lock");
  }

  async function handOffWhileHeld(
    work: (tx: Prisma.TransactionClient, question: { id: string }) => Promise<unknown>,
  ) {
    const question = await fixture(() =>
      createThreadMessage(prisma, {
        threadId,
        role: "user",
        blocks: [{ kind: "text", text: "Plan the launch" }],
      }),
    );
    const source = await fixture(() => queueRun(prisma, ada.id, question, "running"));
    const holder = holdThread((tx) => work(tx, question));
    await holder.held;
    const deps = {
      prisma,
      events: createThreadEvents(prisma),
      jobs: { enqueue: vi.fn(async () => undefined) },
    };
    const handoff = runAsSystem("agent run tool call", () =>
      handoffToGroupBot(deps as never, source, groupId, {
        bot_id: ben.id,
        message: "Take the next stage",
      }),
    );
    await untilWaitingOnALock();
    holder.release();
    await holder.done;
    return handoff;
  }

  const activeRunsOf = (botId: string) =>
    fixture(() =>
      prisma.run.findMany({
        where: { threadId, botId, status: { in: [...ACTIVE_RUN_STATUSES] } },
        select: { id: true },
      }),
    );

  it("refuses a handoff to a member a finishing colleague woke while it waited", async () => {
    await expect(
      handOffWhileHeld((tx, question) => queueRun(tx, ben.id, question)),
    ).resolves.toEqual({
      error: "that member is already working in this thread; mention it in your reply instead",
    });
    expect(await activeRunsOf(ben.id)).toHaveLength(1);
  });

  it("refuses a handoff from a run that Stop ended while it waited", async () => {
    await expect(
      handOffWhileHeld((tx) =>
        tx.run.updateMany({
          where: { threadId, status: { in: [...ACTIVE_RUN_STATUSES] } },
          data: { status: "cancelled", completedAt: new Date() },
        }),
      ),
    ).resolves.toEqual({ error: "source run is no longer active" });
    expect(await activeRunsOf(ben.id)).toEqual([]);
  });
});

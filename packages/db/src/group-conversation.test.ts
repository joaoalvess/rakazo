import { afterEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import {
  advanceGroupConversation,
  exceededGroupConversationBudget,
  groupRunChain,
  lockThreadForRunEnd,
} from "./group-conversation.js";

type Row = Record<string, unknown>;

/** Enough of Prisma's filters for the queries the conversation code makes. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (condition === null || typeof condition !== "object" || condition instanceof Date) {
      return value === condition;
    }
    const filter = condition as Record<string, unknown>;
    if ("in" in filter) return (filter.in as unknown[]).includes(value);
    if ("not" in filter) return value !== filter.not;
    if ("gt" in filter) return value instanceof Date && value > (filter.gt as Date);
    if ("gte" in filter) return value instanceof Date && value >= (filter.gte as Date);
    if ("startsWith" in filter) {
      return typeof value === "string" && value.startsWith(filter.startsWith as string);
    }
    return false;
  });
}

const now = new Date("2026-10-21T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const members = [
  { id: "ada", name: "Ada" },
  { id: "ben", name: "Ben" },
  { id: "cy", name: "Cy" },
];

function conversation(runs: Row[], messages: Row[] = []) {
  const created: Row[] = [];
  const byDate = (key: string) => (a: Row, b: Row) =>
    (b[key] as Date).getTime() - (a[key] as Date).getTime();
  const client = {
    run: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const run = runs.find((row) => row.id === where.id);
        if (!run) return null;
        const source = messages.find((message) => message.id === run.sourceMessageId);
        return { ...run, sourceMessage: source ? { id: source.id, role: source.role } : null };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const run = runs.find((row) => row.id === where.id)!;
        for (const [key, value] of Object.entries(data)) if (value !== undefined) run[key] = value;
        return run;
      }),
      findMany: vi.fn(async ({ where, orderBy }: { where: Row; orderBy?: Row }) => {
        const rows = runs.filter((row) => matches(row, where));
        const [key] = Object.keys(orderBy ?? {});
        return key ? rows.sort(byDate(key)) : rows;
      }),
      count: vi.fn(
        async ({ where }: { where: Row }) => runs.filter((row) => matches(row, where)).length,
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Row }) => runs.find((row) => matches(row, where)) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const run = { ...data, id: `run-${created.length + 1}`, createdAt: now };
        created.push(run);
        return run;
      }),
    },
    message: {
      findUnique: vi.fn(
        async ({ where }: { where: { threadId_clientNonce: { clientNonce: string } } }) =>
          messages.find((row) => row.clientNonce === where.threadId_clientNonce.clientNonce) ??
          null,
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Row }) => messages.find((row) => matches(row, where)) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: Row }) =>
        messages.filter((row) => matches(row, where)).sort((a, b) => Number(b.seq) - Number(a.seq)),
      ),
    },
    task: { create: vi.fn(async () => ({ id: "task-1" })) },
    chatGroupMember: { findMany: vi.fn(async () => members.map((bot) => ({ bot }))) },
  };
  return { client, created, tx: client as unknown as Prisma.TransactionClient };
}

function run(fields: Row): Row {
  return {
    spaceId: "space-1",
    threadId: "thread-1",
    userId: "user-1",
    status: "completed",
    trigger: "user",
    groupChainMessageId: null,
    conversationDecision: null,
    sourceMessageId: null,
    createdAt: minutesAgo(5),
    startedAt: minutesAgo(5),
    completedAt: null,
    ...fields,
  };
}

const question = { id: "question", role: "user", seq: 1, threadId: "thread-1" };
const reply = (text: string) => ({ id: "reply", blocks: [{ kind: "text" as const, text }] });

afterEach(() => {
  delete process.env.GROUP_CONVERSATION_MAX_CHAIN_MESSAGES;
  delete process.env.GROUP_CONVERSATION_MAX_MESSAGES_PER_HOUR;
});

describe("advanceGroupConversation", () => {
  it("records a silent pass on the person's chain and wakes nobody", async () => {
    const runs = [run({ id: "ben-1", botId: "ben", sourceMessageId: "question" })];
    const { tx, created } = conversation(runs, [question]);

    await expect(
      advanceGroupConversation(tx, "group-1", { runId: "ben-1", decision: "pass", now }),
    ).resolves.toEqual({ runIds: [] });

    expect(runs[0]).toMatchObject({
      groupChainMessageId: "question",
      conversationDecision: "pass",
    });
    expect(created).toEqual([]);
  });

  it("wakes every listening member but the author, skipping passes and busy members", async () => {
    const runs = [
      run({
        id: "ada-1",
        botId: "ada",
        sourceMessageId: "question",
        groupChainMessageId: "question",
      }),
      run({
        id: "ben-1",
        botId: "ben",
        groupChainMessageId: "question",
        conversationDecision: "pass",
      }),
      run({ id: "cy-1", botId: "cy", groupChainMessageId: "question", status: "running" }),
    ];
    const { tx, created } = conversation(runs, [question]);

    await expect(
      advanceGroupConversation(tx, "group-1", { runId: "ada-1", posted: reply("Done."), now }),
    ).resolves.toEqual({ runIds: [] });
    expect(created).toEqual([]);

    runs[2]!.status = "completed";
    runs[2]!.conversationDecision = "wait";
    await expect(
      advanceGroupConversation(tx, "group-1", {
        runId: "ada-1",
        posted: reply("@Ben thoughts?"),
        now,
      }),
    ).resolves.toEqual({ runIds: ["run-1", "run-2"] });
    expect(created).toEqual([
      expect.objectContaining({
        botId: "ben",
        trigger: "follow_up",
        sourceMessageId: "reply",
        groupChainMessageId: "question",
        clientNonce: "group-wake:reply:ben",
      }),
      expect.objectContaining({ botId: "cy", clientNonce: "group-wake:reply:cy" }),
    ]);
    expect(runs[0]).toMatchObject({ conversationDecision: "speak" });
  });

  it("starts a chain from a reply that answers no group message", async () => {
    const runs = [run({ id: "routine-1", botId: "cy", trigger: "routine" })];
    const { tx, created } = conversation(runs);

    const woken = await advanceGroupConversation(tx, "group-1", {
      runId: "routine-1",
      posted: reply("Morning summary."),
      now,
    });

    expect(woken.runIds).toHaveLength(2);
    expect(runs[0]).toMatchObject({ groupChainMessageId: "reply", conversationDecision: "speak" });
    expect(created.map((row) => [row.botId, row.groupChainMessageId])).toEqual([
      ["ada", "reply"],
      ["ben", "reply"],
    ]);
  });

  it("pauses once the chain reaches its budget, posting the line only once", async () => {
    process.env.GROUP_CONVERSATION_MAX_CHAIN_MESSAGES = "2";
    const runs = [
      run({
        id: "ada-1",
        botId: "ada",
        groupChainMessageId: "question",
        conversationDecision: "speak",
      }),
      run({
        id: "ben-1",
        botId: "ben",
        sourceMessageId: "question",
        groupChainMessageId: "question",
      }),
    ];
    const messages: Row[] = [question];
    const { tx, created } = conversation(runs, messages);

    const paused = await advanceGroupConversation(tx, "group-1", {
      runId: "ben-1",
      posted: reply("Pong."),
      now,
    });

    expect(paused).toEqual({
      runIds: [],
      pause: {
        clientNonce: "group-pause:chain:question",
        text: "Bots paused this conversation after 2 messages. Send a message to continue.",
      },
    });
    expect(created).toEqual([]);
    messages.push({ id: "line", clientNonce: "group-pause:chain:question" });
    await expect(
      advanceGroupConversation(tx, "group-1", { runId: "ben-1", posted: reply("Pong."), now }),
    ).resolves.toEqual({ runIds: [] });
  });

  it("hands a waiting member the reply it missed while it was deciding", async () => {
    const runs = [
      run({
        id: "ada-1",
        botId: "ada",
        groupChainMessageId: "question",
        conversationDecision: "speak",
        completedAt: minutesAgo(1),
      }),
      run({
        id: "cy-1",
        botId: "cy",
        sourceMessageId: "question",
        groupChainMessageId: "question",
      }),
    ];
    const messages: Row[] = [
      question,
      {
        id: "ada-reply",
        threadId: "thread-1",
        runId: "ada-1",
        role: "bot",
        seq: 2,
        blocks: reply("Lisbon.").blocks,
      },
    ];
    const { tx, created } = conversation(runs, messages);

    await expect(
      advanceGroupConversation(tx, "group-1", { runId: "cy-1", decision: "wait", now }),
    ).resolves.toEqual({ runIds: ["run-1"] });
    expect(created).toEqual([
      expect.objectContaining({
        botId: "cy",
        sourceMessageId: "ada-reply",
        groupChainMessageId: "question",
      }),
    ]);
  });
});

describe("exceededGroupConversationBudget", () => {
  const posted = (count: number, fields: Row = {}) =>
    Array.from({ length: count }, (_, index) =>
      run({
        id: `run-${index}`,
        botId: "ada",
        groupChainMessageId: "question",
        conversationDecision: "speak",
        completedAt: minutesAgo(10),
        ...fields,
      }),
    );

  it("names the chain budget, then the hourly one, counting a pending handoff", async () => {
    process.env.GROUP_CONVERSATION_MAX_CHAIN_MESSAGES = "3";
    process.env.GROUP_CONVERSATION_MAX_MESSAGES_PER_HOUR = "5";
    const input = { threadId: "thread-1", chainMessageId: "question", now };

    await expect(exceededGroupConversationBudget(conversation(posted(2)).tx, input)).resolves.toBe(
      null,
    );
    await expect(
      exceededGroupConversationBudget(conversation(posted(2)).tx, { ...input, pending: 1 }),
    ).resolves.toBe("chain");
    const otherChains = posted(5, { groupChainMessageId: "older" });
    await expect(
      exceededGroupConversationBudget(conversation(otherChains).tx, input),
    ).resolves.toBe("hour");
    const lastHour = posted(5, { groupChainMessageId: "older", completedAt: minutesAgo(61) });
    await expect(exceededGroupConversationBudget(conversation(lastHour).tx, input)).resolves.toBe(
      null,
    );
  });

  it("falls back to 40 per chain and 60 per hour", async () => {
    process.env.GROUP_CONVERSATION_MAX_CHAIN_MESSAGES = "zero";
    const input = { threadId: "thread-1", chainMessageId: "question", now };

    await expect(exceededGroupConversationBudget(conversation(posted(39)).tx, input)).resolves.toBe(
      null,
    );
    await expect(exceededGroupConversationBudget(conversation(posted(40)).tx, input)).resolves.toBe(
      "chain",
    );
    const spread = posted(60).map((row, index) => ({ ...row, groupChainMessageId: `c${index}` }));
    await expect(exceededGroupConversationBudget(conversation(spread).tx, input)).resolves.toBe(
      "hour",
    );
  });
});

describe("groupRunChain", () => {
  it("follows a recorded chain or the person's message a run answers", async () => {
    const { tx } = conversation(
      [
        run({ id: "handoff", botId: "ben", trigger: "follow_up", groupChainMessageId: "root" }),
        run({ id: "person", botId: "ada", sourceMessageId: "question" }),
        run({ id: "routine", botId: "cy", trigger: "routine" }),
      ],
      [question],
    );

    await expect(groupRunChain(tx, "handoff")).resolves.toBe("root");
    await expect(groupRunChain(tx, "person")).resolves.toBe("question");
    await expect(groupRunChain(tx, "routine")).resolves.toBe(null);
  });
});

describe("lockThreadForRunEnd", () => {
  it("names the thread's group only when it is a live conversation", async () => {
    const tx = (rows: unknown[]) =>
      ({ $queryRaw: vi.fn(async () => rows) }) as unknown as Prisma.TransactionClient;

    await expect(lockThreadForRunEnd(tx([{ conversationGroupId: "g1" }]), "t1")).resolves.toBe(
      "g1",
    );
    await expect(lockThreadForRunEnd(tx([{ conversationGroupId: null }]), "t1")).resolves.toBe(
      null,
    );
  });
});

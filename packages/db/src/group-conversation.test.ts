import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import {
  groupChainRunNonce,
  groupRunHop,
  lockThreadForRunEnd,
  queueGroupConversationTurn,
} from "./group-conversation.js";

type RunRow = {
  clientNonce?: string | null;
  sourceMessage?: { runId: string | null; blocks: unknown } | null;
};

function hopTx(runs: Record<string, RunRow>) {
  return {
    run: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => runs[args.where.id] ?? null),
    },
  } as unknown as Prisma.TransactionClient;
}

type StartedRun = { botId: string; status?: string; error?: string | null };

function turnTx(options: {
  active?: Array<{ id: string; botId: string; status: string; trigger: string; seq?: number }>;
  started?: Array<string | StartedRun>;
  steered?: string[];
}) {
  const client = {
    run: {
      findMany: vi.fn(async (args: { where: { status?: unknown } }) =>
        args.where.status
          ? (options.active ?? []).map(({ seq, ...run }) => ({
              ...run,
              sourceMessage: seq === undefined ? null : { seq },
            }))
          : (options.started ?? []).map((run) =>
              typeof run === "string" ? { botId: run, status: "completed", error: null } : run,
            ),
      ),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        id: `run-${String(args.data.botId)}`,
        ...args.data,
      })),
    },
    steeringMessage: {
      findMany: vi.fn(async () => (options.steered ?? []).map((botId) => ({ botId }))),
      create: vi.fn(async () => ({ id: "steering-1" })),
    },
    task: { create: vi.fn(async () => ({ id: "task-1" })) },
  };
  return { client, tx: client as unknown as Prisma.TransactionClient };
}

const members = [{ id: "ada" }, { id: "ben" }, { id: "cy" }];
const turnInput = {
  spaceId: "space-1",
  threadId: "thread-1",
  userId: "user-1",
  members,
  source: { id: "message-1", seq: 4 },
  prompt: "What next?",
};

describe("groupRunHop", () => {
  it("starts at zero for a person's message and reads a handoff's recorded hop", async () => {
    const tx = hopTx({
      person: { clientNonce: "group-chain:m1:ada", sourceMessage: { runId: null, blocks: [] } },
      handoff: {
        sourceMessage: {
          runId: "person",
          blocks: [{ kind: "handoff", fromBotId: "ada", toBotId: "ben", summary: "go", hop: 3 }],
        },
      },
    });

    await expect(groupRunHop(tx, "person")).resolves.toBe(0);
    await expect(groupRunHop(tx, "handoff")).resolves.toBe(3);
  });

  it("adds one hop for every mention back to the person's message", async () => {
    const tx = hopTx({
      first: { clientNonce: "group-chain:m1:ada", sourceMessage: { runId: null, blocks: [] } },
      second: {
        clientNonce: "group-mention:m2:ben",
        sourceMessage: { runId: "first", blocks: [] },
      },
      third: {
        clientNonce: "group-mention:m3:ada",
        sourceMessage: { runId: "second", blocks: [] },
      },
    });

    await expect(groupRunHop(tx, "third")).resolves.toBe(2);
  });
});

describe("queueGroupConversationTurn", () => {
  it("waits while a turn on the message is still running", async () => {
    const { client, tx } = turnTx({
      active: [{ id: "run-ada", botId: "ada", status: "running", trigger: "user", seq: 4 }],
    });

    await expect(queueGroupConversationTurn(tx, turnInput)).resolves.toEqual([]);
    expect(client.run.create).not.toHaveBeenCalled();
  });

  it("queues the first member that has not answered the message", async () => {
    const { client, tx } = turnTx({ started: ["ada"], steered: ["ben"] });

    const runs = await queueGroupConversationTurn(tx, turnInput);

    expect(runs.map((run) => run.botId)).toEqual(["cy"]);
    expect(client.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        botId: "cy",
        trigger: "user",
        clientNonce: groupChainRunNonce("message-1", "cy"),
        sourceMessageId: "message-1",
      }),
    });
  });

  it("stays stopped after the person stopped a turn, but moves past an expired one", async () => {
    const stopped = turnTx({ started: [{ botId: "ada", status: "cancelled", error: null }] });
    await expect(queueGroupConversationTurn(stopped.tx, turnInput)).resolves.toEqual([]);
    expect(stopped.client.run.create).not.toHaveBeenCalled();

    const expired = turnTx({
      started: [{ botId: "ada", status: "cancelled", error: "Stopped waiting for an answer" }],
    });
    const runs = await queueGroupConversationTurn(expired.tx, turnInput);
    expect(runs.map((run) => run.botId)).toEqual(["ben"]);
  });

  it("ignores a stopped turn of a bot that left the group", async () => {
    const { tx } = turnTx({ started: [{ botId: "zed", status: "cancelled", error: null }] });

    const runs = await queueGroupConversationTurn(tx, turnInput);

    expect(runs.map((run) => run.botId)).toEqual(["ada"]);
  });

  it("steers a member busy with older work and moves on", async () => {
    const { client, tx } = turnTx({
      active: [{ id: "run-old", botId: "ada", status: "running", trigger: "user", seq: 1 }],
    });

    const runs = await queueGroupConversationTurn(tx, turnInput);

    expect(client.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "message-1", botId: "ada", userId: "user-1", runId: "run-old" },
    });
    expect(runs.map((run) => run.botId)).toEqual(["ben"]);
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

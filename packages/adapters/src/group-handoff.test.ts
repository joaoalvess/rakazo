import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  groupConversationAllowsSilence,
  handoffToGroupBot,
  loadGroupContext,
} from "./group-handoff.js";

const run = {
  id: "run-a",
  spaceId: "workspace-1",
  threadId: "thread-1",
  botId: "bot-a",
  userId: "user-1",
};

function harness(
  sourceBlocks: unknown,
  existing?: { sourceRuns: { id: string; botId: string }[] },
  ancestry: Record<string, unknown> = {},
  conversationMode = false,
) {
  const runCreate = vi.fn(async () => ({ id: "run-b" }));
  const messageCreate = vi.fn(async () => ({ id: "message-1" }));
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "group-1" }]),
    chatGroup: {
      findFirst: vi.fn(async () => ({
        id: "group-1",
        conversationMode,
        members: ["bot-a", "bot-b", "bot-c"].map((id) => ({
          bot: { id, name: id.toUpperCase() },
        })),
      })),
      update: vi.fn(async () => ({ id: "group-1" })),
    },
    run: {
      findFirst: vi.fn(async () => ({
        id: run.id,
        sourceMessage: { blocks: sourceBlocks },
      })),
      findUnique: vi.fn(async (args: { where: { id: string } }) => ({
        status: "running",
        ...(ancestry[args.where.id] as object),
      })),
      create: runCreate,
    },
    message: {
      findUnique: vi.fn(async () => existing ?? null),
      create: messageCreate,
    },
    thread: {
      update: vi.fn(async (args: { select: { nextMessageSeq?: boolean } }) =>
        args.select.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 2 },
      ),
    },
    task: { create: vi.fn(async () => ({ id: "task-b" })) },
    event: {
      findFirst: vi.fn(async () => ({ seq: 1 })),
      create: vi.fn(async () => ({ seq: 1 })),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
  } as unknown as PrismaClient;
  return {
    deps: {
      prisma,
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
    },
    messageCreate,
    runCreate,
    tx,
  };
}

describe("group handoff ownership", () => {
  it("marks a new ownership transfer as a follow-up with a chain hop", async () => {
    const { deps, messageCreate, runCreate } = harness([{ kind: "text", text: "user request" }]);

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "Do the distinct next stage",
      }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-b" });

    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blocks: [
            expect.objectContaining({
              kind: "handoff",
              fromBotId: "bot-a",
              toBotId: "bot-b",
              hop: 1,
            }),
          ],
        }),
      }),
    );
    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: "follow_up" }) }),
    );
  });

  it("refuses to bounce a handed-off stage straight back to its sender", async () => {
    const { deps, runCreate } = harness([
      { kind: "handoff", fromBotId: "bot-b", toBotId: "bot-a", text: "Investigate", hop: 1 },
    ]);

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "You investigate it",
      }),
    ).resolves.toEqual({
      error:
        "do not hand this stage back to its sender; post the result in the shared thread instead",
    });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("caps longer multi-agent handoff chains", async () => {
    const { deps, runCreate } = harness([
      { kind: "handoff", fromBotId: "bot-b", toBotId: "bot-a", text: "Stage six", hop: 6 },
    ]);

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-c",
        message: "Stage seven",
      }),
    ).resolves.toEqual({
      error:
        "group handoff limit reached for this chain; finish the current stage in the shared thread instead",
    });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("reuses the recorded transfer when a source run is retried", async () => {
    const { deps, messageCreate, runCreate } = harness([], {
      sourceRuns: [{ id: "run-b", botId: "bot-b" }],
    });

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-c",
        message: "A duplicate stage",
      }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-b", runId: "run-b" });
    expect(messageCreate).not.toHaveBeenCalled();
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("rejects malformed source ancestry instead of restarting its hop count", async () => {
    const { deps, runCreate } = harness({ kind: "not-an-array" });

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "Continue",
      }),
    ).resolves.toEqual({ error: "cannot verify the group handoff chain" });
    expect(runCreate).not.toHaveBeenCalled();
  });

  const mentionAncestry = {
    "run-a": {
      clientNonce: "group-mention:m2:bot-a",
      sourceMessage: { runId: "run-z", blocks: [] },
    },
    "run-z": {
      clientNonce: "group-chain:m1:bot-z",
      sourceMessage: { runId: null, blocks: [] },
    },
  };
  const hopRead = expect.objectContaining({
    select: expect.objectContaining({ clientNonce: true }),
  });

  it("counts the mentions that woke the sender toward the chain's hop", async () => {
    const { deps, messageCreate } = harness(
      [{ kind: "text", text: "@A can you check?" }],
      undefined,
      mentionAncestry,
      true,
    );

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", { bot_id: "bot-b", message: "Next stage" }),
    ).resolves.toMatchObject({ ok: true });
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ blocks: [expect.objectContaining({ hop: 2 })] }),
      }),
    );
  });

  it("reads no mention ancestry outside a conversation group", async () => {
    const { deps, messageCreate, tx } = harness(
      [{ kind: "text", text: "@A can you check?" }],
      undefined,
      mentionAncestry,
    );

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", { bot_id: "bot-b", message: "Next stage" }),
    ).resolves.toMatchObject({ ok: true });
    expect(tx.run.findUnique).not.toHaveBeenCalledWith(hopRead);
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ blocks: [expect.objectContaining({ hop: 1 })] }),
      }),
    );
  });
});

describe("conversation groups", () => {
  const self = { id: "bot-b", name: "Ben" };

  function prisma(conversationMode: boolean) {
    return {
      chatGroup: {
        findUnique: vi.fn(async () => ({
          id: "group-1",
          name: "Crew",
          conversationMode,
          members: [
            { bot: { id: "bot-a", name: "Ada", title: "", description: "" } },
            { bot: { id: "bot-b", name: "Ben", title: "", description: "" } },
          ],
        })),
      },
    } as unknown as PrismaClient;
  }

  it("tells members they are in a conversation only when the group is one", async () => {
    await expect(loadGroupContext(prisma(true), "group-1", self)).resolves.toEqual({
      context: expect.stringContaining("This group is a conversation"),
      conversationMode: true,
    });
    await expect(loadGroupContext(prisma(false), "group-1", self)).resolves.toEqual({
      context: expect.stringContaining("Never bounce a stage between members."),
      conversationMode: false,
    });
  });

  it.each([
    ["a person's message that names nobody", "user", [{ kind: "text", text: "@Ada next?" }], true],
    [
      "a person's message that names the bot",
      "user",
      [{ kind: "text", text: "@Ben next?" }],
      false,
    ],
    [
      "a colleague's thanks that names the bot",
      "bot",
      [{ kind: "text", text: "Thanks @Ben" }],
      true,
    ],
    [
      "a handoff to the bot",
      "bot",
      [{ kind: "handoff", fromBotId: "bot-a", toBotId: "bot-b", text: "Take it", hop: 1 }],
      false,
    ],
  ] as const)("decides whether a member may stay silent on %s", (_label, role, blocks, allowed) => {
    expect(groupConversationAllowsSilence({ role, blocks: [...blocks] }, self)).toBe(allowed);
  });

  it("keeps a member answering when its source message is not in the loaded history", () => {
    expect(groupConversationAllowsSilence(undefined, self)).toBe(false);
  });
});

import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { liveComputerStep } from "./computer-step";

const message = (id: string, botId: string, blocks: ThreadMessage["blocks"]): ThreadMessage => ({
  id,
  threadId: "thread-1",
  seq: 1,
  role: "bot",
  botId,
  blocks,
  createdAt: "2026-10-23T12:00:00.000Z",
});

describe("liveComputerStep", () => {
  it("shows the last line the bot narrated in its live run", () => {
    const messages = [
      message("message-1", "bot-1", [{ kind: "text", text: "Pronto." }]),
      message("progress:run-1", "bot-1", [
        { kind: "text", text: "Abrindo a loja.\n" },
        { kind: "steps", steps: [{ label: "Browser navigate", count: 1 }] },
        { kind: "progress", text: "Preenchendo o endereço de entrega" },
      ]),
      message("progress:run-2", "bot-2", [{ kind: "progress", text: "Outro bot" }]),
    ];
    expect(liveComputerStep(messages, "bot-1")).toBe("Preenchendo o endereço de entrega");
  });

  it("shows nothing without live narration and shortens long lines", () => {
    expect(liveComputerStep([], "bot-1")).toBeUndefined();
    expect(
      liveComputerStep(
        [
          message("progress:run-1", "bot-1", [
            { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
          ]),
        ],
        "bot-1",
      ),
    ).toBeUndefined();
    const long = liveComputerStep(
      [message("progress:run-1", "bot-1", [{ kind: "progress", text: "a".repeat(200) }])],
      "bot-1",
    );
    expect(long).toHaveLength(80);
    expect(long?.endsWith("…")).toBe(true);
  });
});

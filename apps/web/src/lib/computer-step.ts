import type { ThreadMessage } from "@rakazo/contracts";

const MAX_STEP_LENGTH = 80;

export function liveComputerStep(
  messages: readonly ThreadMessage[],
  botId: string,
): string | undefined {
  const live = [...messages]
    .reverse()
    .find((message) => message.id.startsWith("progress:") && message.botId === botId);
  const narration = live?.blocks
    .flatMap((block) => (block.kind === "progress" || block.kind === "text" ? [block.text] : []))
    .join("");
  const line = narration
    ?.split("\n")
    .map((text) => text.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) return undefined;
  return line.length > MAX_STEP_LENGTH ? `${line.slice(0, MAX_STEP_LENGTH - 1)}…` : line;
}

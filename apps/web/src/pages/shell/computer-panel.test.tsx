// @vitest-environment jsdom

import type { Bot, ComputerStatus } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
}));
vi.mock("../../lib/rpc", () => ({ rpc: {} }));

import { ComputerPanel } from "./computer-panel";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function renderPanel(screenAsleep: boolean, onOpen = () => undefined) {
  return act(async () =>
    root.render(
      <ComputerPanel
        bot={{ id: "bot-1", name: "Atlas" } as Bot}
        computer={{ botId: "bot-1", state: "running", graphical: true } as ComputerStatus}
        computerOpen={false}
        embeddedScreenUrl="http://127.0.0.1:5173/novnc/embed.html"
        screenAsleep={screenAsleep}
        screenFrameRef={() => undefined}
        computerScreenError={null}
        computerBooting={null}
        booting={false}
        showingRecoveryHint={false}
        showComputerRecoveryHint={false}
        onRecovered={() => undefined}
        onRecoveryDismissed={() => undefined}
        onOpen={onOpen}
        routines={[]}
        onCreateRoutine={() => undefined}
        onEditRoutine={() => undefined}
        onStopRun={() => undefined}
      />,
    ),
  );
}

it("says over the last frame that a sleeping screen wakes when opened", async () => {
  const onOpen = vi.fn();
  await renderPanel(true, onOpen);
  expect(container.querySelector("iframe")).not.toBeNull();
  expect(container.querySelector("[data-testid=computer-asleep]")?.textContent).toBe(
    "Computer is asleep. Open it to wake.",
  );
  container.querySelector<HTMLButtonElement>("[data-testid=computer-preview-open]")!.click();
  expect(onOpen).toHaveBeenCalledOnce();
  await renderPanel(false);
  expect(container.querySelector("[data-testid=computer-asleep]")).toBeNull();
});

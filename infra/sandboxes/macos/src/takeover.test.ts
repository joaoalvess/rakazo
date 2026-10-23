import { describe, expect, it } from "vitest";
import type { PageView } from "./chrome.js";
import type { InputEvent, WindowInfo } from "./displayd.js";
import { pageKey, TakeoverInput } from "./takeover.js";

const display = { x: 1280, y: 0, width: 1280, height: 800 };
const chromeWindow: WindowInfo = {
  id: 1924,
  owner: "Google Chrome",
  pid: 42,
  layer: 0,
  bounds: { x: 1280, y: 30, width: 1280, height: 770 },
};

function takeover(options: { page?: boolean; scale?: number; windows?: WindowInfo[] } = {}) {
  let clock = 0;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const native: InputEvent[][] = [];
  const errors: Error[] = [];
  const page: PageView = {
    rect: { x: 1280, y: 110, width: 1280, height: 690 },
    scale: options.scale ?? 1,
    window: chromeWindow.bounds,
    pid: chromeWindow.pid,
    send: async (method, params) => {
      calls.push({ method, params: params as Record<string, unknown> });
      return {};
    },
  };
  const input = new TakeoverInput(
    {
      display: async () => display,
      page: async () => (options.page === false ? undefined : page),
      windows: async () => options.windows ?? [chromeWindow],
      native: async (events) => native.push(events),
    },
    (error) => errors.push(error),
    () => clock,
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  return {
    calls,
    native,
    errors,
    send: async (...events: InputEvent[]) => {
      input.send(events);
      await settle();
    },
    release: async () => {
      input.release();
      await settle();
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const mouse = (calls: Array<{ method: string; params: Record<string, unknown> }>) =>
  calls
    .filter((call) => call.method === "Input.dispatchMouseEvent")
    .map(({ params }) => [params.type, params.x, params.y, params.button, params.clickCount]);

describe("TakeoverInput", () => {
  it("sends clicks inside the bot's page to the page in CSS pixels", async () => {
    const { calls, native, send } = takeover({ scale: 1.25 });
    await send(
      { t: "p", x: 100, y: 235, m: 0 },
      { t: "p", x: 100, y: 235, m: 1 },
      { t: "p", x: 100, y: 235, m: 0 },
    );
    expect(native).toEqual([]);
    expect(mouse(calls)).toEqual([
      ["mouseMoved", 80, 100, "none", undefined],
      ["mousePressed", 80, 100, "left", 1],
      ["mouseReleased", 80, 100, "left", 1],
    ]);
  });

  it("sends the toolbar and everything outside the page to the Mac", async () => {
    const { calls, native, send } = takeover();
    await send(
      { t: "p", x: 300, y: 60, m: 1 },
      { t: "p", x: 300, y: 300, m: 1 },
      { t: "p", x: 300, y: 300, m: 0 },
    );
    expect(calls).toEqual([]);
    expect(native).toEqual([
      [
        { t: "p", x: 300, y: 60, m: 1 },
        { t: "p", x: 300, y: 300, m: 1 },
        { t: "p", x: 300, y: 300, m: 0 },
      ],
    ]);
  });

  it("keeps a drag that starts in the page in the page", async () => {
    const { calls, native, send } = takeover();
    await send(
      { t: "p", x: 10, y: 400, m: 1 },
      { t: "p", x: 10, y: 50, m: 1 },
      { t: "p", x: 10, y: 50, m: 0 },
    );
    expect(native).toEqual([]);
    expect(mouse(calls)).toEqual([
      ["mousePressed", 10, 290, "left", 1],
      ["mouseMoved", 10, -60, "left", undefined],
      ["mouseReleased", 10, -60, "left", 1],
    ]);
  });

  it("counts double clicks", async () => {
    const { calls, send, advance } = takeover();
    await send({ t: "p", x: 10, y: 400, m: 1 }, { t: "p", x: 10, y: 400, m: 0 });
    advance(200);
    await send({ t: "p", x: 11, y: 401, m: 1 }, { t: "p", x: 11, y: 401, m: 0 });
    advance(900);
    await send({ t: "p", x: 11, y: 401, m: 1 });
    expect(mouse(calls).map((call) => call[4])).toEqual([1, 1, 2, 2, 1]);
  });

  it("scrolls the page under the pointer", async () => {
    const { calls, send } = takeover();
    await send({ t: "p", x: 10, y: 400, m: 16 }, { t: "p", x: 10, y: 400, m: 0 });
    expect(calls[0]?.params).toMatchObject({ type: "mouseWheel", deltaX: 0, deltaY: 50 });
  });

  it("types into the page until a click lands outside it", async () => {
    const { calls, native, send } = takeover();
    await send(
      { t: "k", s: 0x61, d: true },
      { t: "k", s: 0x61, d: false },
      { t: "text", s: "senha" },
    );
    expect(calls.map((call) => [call.method, call.params.type ?? call.params.text])).toEqual([
      ["Input.dispatchKeyEvent", "keyDown"],
      ["Input.dispatchKeyEvent", "keyUp"],
      ["Input.insertText", "senha"],
    ]);
    await send(
      { t: "p", x: 300, y: 60, m: 1 },
      { t: "p", x: 300, y: 60, m: 0 },
      { t: "k", s: 0x62, d: true },
    );
    expect(native.at(-1)?.at(-1)).toEqual({ t: "k", s: 0x62, d: true });
  });

  it("sends a key's release where its press went", async () => {
    const { calls, native, send } = takeover();
    await send({ t: "k", s: 0xffe1, d: true });
    await send({ t: "p", x: 300, y: 60, m: 1 }, { t: "p", x: 300, y: 60, m: 0 });
    await send({ t: "k", s: 0xffe1, d: false });
    expect(calls.filter((call) => call.method === "Input.dispatchKeyEvent")).toHaveLength(2);
    expect(native.flat().filter((event) => event.t === "k")).toEqual([]);
  });

  it("uses the Mac when the bot has no page", async () => {
    const { calls, native, send } = takeover({ page: false });
    await send({ t: "p", x: 10, y: 400, m: 1 }, { t: "text", s: "x" });
    expect(calls).toEqual([]);
    expect(native.flat()).toEqual([
      { t: "p", x: 10, y: 400, m: 1 },
      { t: "text", s: "x" },
    ]);
  });

  it("sends clicks on a window above the page to the Mac", async () => {
    const prompt: WindowInfo = {
      id: 330,
      owner: "SecurityAgent",
      pid: 7,
      layer: 0,
      bounds: { x: 1600, y: 200, width: 400, height: 200 },
    };
    const { calls, native, send } = takeover({ windows: [prompt, chromeWindow] });
    await send({ t: "p", x: 500, y: 300, m: 1 }, { t: "p", x: 500, y: 300, m: 0 });
    await send({ t: "k", s: 0x61, d: true });
    await send({ t: "p", x: 100, y: 300, m: 1 }, { t: "p", x: 100, y: 300, m: 0 });
    expect(native.flat()).toEqual([
      { t: "p", x: 500, y: 300, m: 1 },
      { t: "p", x: 500, y: 300, m: 0 },
      { t: "k", s: 0x61, d: true },
    ]);
    expect(mouse(calls).map((call) => call[0])).toEqual(["mousePressed", "mouseReleased"]);
  });

  it("does not take another app's window with the same frame for the bot's page", async () => {
    const editor = { ...chromeWindow, id: 568, owner: "TextEdit", pid: 8 };
    const { calls, native, send } = takeover({ windows: [editor, chromeWindow] });
    await send({ t: "p", x: 100, y: 300, m: 1 });
    expect(calls).toEqual([]);
    expect(native.flat()).toEqual([{ t: "p", x: 100, y: 300, m: 1 }]);
  });

  it("keeps the pointer off the bottom row so the Dock never moves to a bot screen", async () => {
    const { native, send } = takeover({ page: false });
    await send({ t: "p", x: 640, y: 799, m: 0 }, { t: "p", x: 640, y: 798, m: 0 });
    expect(native.flat()).toEqual([
      { t: "p", x: 640, y: 798, m: 0 },
      { t: "p", x: 640, y: 798, m: 0 },
    ]);
  });

  it("releases buttons and keys held in the page when control ends", async () => {
    const { calls, release, send } = takeover();
    await send({ t: "p", x: 10, y: 400, m: 1 }, { t: "k", s: 0xffe7, d: true });
    calls.length = 0;
    await release();
    expect(calls.map((call) => call.params.type)).toEqual(["keyUp", "mouseReleased"]);
  });
});

describe("pageKey", () => {
  it("types printable keys with text and maps special keys", () => {
    expect(pageKey(0xe7, true, 0)).toEqual([
      {
        type: "keyDown",
        key: "ç",
        windowsVirtualKeyCode: 0,
        modifiers: 0,
        text: "ç",
        unmodifiedText: "ç",
      },
    ]);
    expect(pageKey(0x41, true, 8)[0]).toMatchObject({
      key: "A",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      text: "A",
    });
    expect(pageKey(0xff0d, true, 0)[0]).toMatchObject({
      type: "keyDown",
      key: "Enter",
      text: "\r",
    });
    expect(pageKey(0xff08, true, 0)[0]).toMatchObject({
      type: "rawKeyDown",
      key: "Backspace",
      windowsVirtualKeyCode: 8,
    });
    expect(pageKey(0xff08, false, 0)).toEqual([
      {
        type: "keyUp",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        modifiers: 0,
      },
    ]);
    expect(pageKey(0x1000394, true, 0)[0]).toMatchObject({ text: "Δ" });
    expect(pageKey(0xfe52, true, 0)).toEqual([]);
  });

  it("turns Mac shortcuts into editing commands without text", () => {
    expect(pageKey(0x61, true, 4)).toEqual([
      {
        type: "rawKeyDown",
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        modifiers: 4,
        commands: ["selectAll"],
      },
    ]);
    expect(pageKey(0x5a, true, 12)[0]).toMatchObject({ commands: ["redo"] });
    expect(pageKey(0xff51, true, 1)[0]).toMatchObject({ commands: ["moveWordLeft"] });
    expect(pageKey(0x63, true, 2)[0]).not.toHaveProperty("text");
  });
});

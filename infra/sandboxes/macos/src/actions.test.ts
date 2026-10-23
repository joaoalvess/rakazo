import { describe, expect, it } from "vitest";
import { BotComputer, type ComputerAction, parseKey } from "./actions.js";
import type { PageView } from "./chrome.js";
import type { Rect, WindowInfo } from "./displayd.js";
import { DriverError } from "./driver.js";

const display = { x: 1280, y: 0, width: 1280, height: 800 };
const chromeWindow: WindowInfo = {
  id: 1924,
  owner: "Google Chrome",
  title: "Login de teste",
  pid: 42,
  layer: 0,
  bounds: { x: 1280, y: 30, width: 1280, height: 770 },
};
const editor: WindowInfo = {
  id: 568,
  owner: "TextEdit",
  title: "notas.txt",
  pid: 8,
  layer: 0,
  bounds: { x: 1480, y: 130, width: 800, height: 500 },
};

function computer(
  options: {
    page?: boolean;
    scale?: number;
    windows?: WindowInfo[];
    others?: Rect[];
    driver?: (tool: string, args: Record<string, unknown>) => Record<string, unknown>;
  } = {},
) {
  const cdp: Array<{ method: string; params: Record<string, unknown> }> = [];
  const driver: Array<[string, Record<string, unknown>]> = [];
  const overlays: unknown[] = [];
  const sleeps: number[] = [];
  const page: PageView = {
    rect: { x: 1280, y: 110, width: 1280, height: 690 },
    scale: options.scale ?? 1,
    window: chromeWindow.bounds,
    pid: chromeWindow.pid,
    send: async (method, params) => {
      cdp.push({ method, params: params as Record<string, unknown> });
      return {};
    },
  };
  const bot = new BotComputer(
    {
      display: async () => display,
      otherDisplays: async () => options.others ?? [],
      page: async () => (options.page === false ? undefined : page),
      windows: async () => options.windows ?? [chromeWindow],
      driver: async (tool, args) => {
        driver.push([tool, args]);
        return options.driver?.(tool, args) ?? { effect: "unverifiable" };
      },
      raise: async (pid, window) => driver.push(["raise", { pid, window }]),
      foreground: (work) => work(),
      browser: async (visible) => driver.push(["browser", { visible }]),
      overlay: async (update) => overlays.push(update),
    },
    async (ms) => {
      sleeps.push(ms);
    },
  );
  const act = (...actions: ComputerAction[]) => bot.act(actions);
  return { bot, act, cdp, driver, overlays, sleeps };
}

const click = (x: number, y: number): ComputerAction => ({ kind: "pointer", x, y, type: "click" });

const mouse = (cdp: Array<{ method: string; params: Record<string, unknown> }>) =>
  cdp
    .filter((call) => call.method === "Input.dispatchMouseEvent")
    .map(({ params }) => [params.type, params.x, params.y, params.button, params.clickCount]);

describe("BotComputer", () => {
  it("clicks the bot's page in CSS pixels and draws the click", async () => {
    const { act, bot, cdp, driver, overlays } = computer({ scale: 1.25 });
    expect(await act(click(100, 235))).toBe(1);
    expect(mouse(cdp)).toEqual([
      ["mouseMoved", 80, 100, "none", undefined],
      ["mousePressed", 80, 100, "left", 1],
      ["mouseReleased", 80, 100, "left", 1],
    ]);
    expect(driver).toEqual([]);
    expect(overlays).toEqual([{ cursor: { x: 100, y: 235 }, click: { x: 100, y: 235 } }]);
    expect(bot.position).toEqual({ x: 100, y: 235 });
  });

  it("turns repeated clicks into a double click", async () => {
    const page = computer();
    await page.act(click(10, 400), click(10, 400));
    expect(mouse(page.cdp).map((call) => [call[0], call[4]])).toEqual([
      ["mouseMoved", undefined],
      ["mousePressed", 1],
      ["mouseReleased", 1],
      ["mousePressed", 2],
      ["mouseReleased", 2],
    ]);
    const native = computer({ windows: [editor, chromeWindow] });
    await native.act(click(400, 300), click(400, 300));
    expect(native.driver).toEqual([
      ["click", { pid: 8, window_id: 568, x: 200, y: 170, button: "left", count: 2 }],
    ]);
  });

  it("drives native windows through cua-driver in window coordinates", async () => {
    const { act, cdp, driver, overlays } = computer({ windows: [editor, chromeWindow] });
    await act(
      click(400, 300),
      { kind: "clipboard", text: "Olá\nmundo" },
      { kind: "key", key: "Return" },
      { kind: "key", key: "s", modifiers: ["cmd"] },
    );
    expect(cdp).toEqual([]);
    expect(driver).toEqual([
      ["click", { pid: 8, window_id: 568, x: 200, y: 170, button: "left" }],
      ["type_text", { pid: 8, window_id: 568, text: "Olá\nmundo" }],
      ["press_key", { pid: 8, window_id: 568, key: "return" }],
      ["hotkey", { pid: 8, window_id: 568, keys: ["cmd", "s"] }],
    ]);
    expect(overlays.slice(1)).toEqual([{ typing: true }, { typing: false }]);
  });

  it("raises the window and types in the foreground when its app has other windows", async () => {
    const { act, driver } = computer({
      windows: [editor, chromeWindow],
      driver: (tool, args) => {
        if (tool === "type_text" && !args.delivery_mode) {
          throw new DriverError("cua-driver type_text failed", "same_pid_keyboard_ambiguity");
        }
        return { effect: "unverifiable" };
      },
    });
    await act(click(400, 300), { kind: "clipboard", text: "oi" });
    expect(driver.slice(1)).toEqual([
      ["type_text", { pid: 8, window_id: 568, text: "oi" }],
      ["raise", { pid: 8, window: 568 }],
      ["bring_to_front", { pid: 8, window_id: 568 }],
      ["type_text", { pid: 8, window_id: 568, text: "oi", delivery_mode: "foreground" }],
    ]);
  });

  it("sends Chrome's toolbar to cua-driver", async () => {
    const { act, cdp, driver } = computer();
    await act(click(300, 60), { kind: "clipboard", text: "example.com" });
    expect(cdp).toEqual([]);
    expect(driver).toEqual([
      ["click", { pid: 42, window_id: 1924, x: 300, y: 30, button: "left" }],
      ["type_text", { pid: 42, window_id: 1924, text: "example.com" }],
    ]);
  });

  it("types into the page and presses Enter between lines", async () => {
    const { act, cdp } = computer();
    await act({ kind: "clipboard", text: "a\nb" });
    expect(cdp.map((call) => [call.method, call.params.type ?? call.params.text])).toEqual([
      ["Input.insertText", "a"],
      ["Input.dispatchKeyEvent", "keyDown"],
      ["Input.dispatchKeyEvent", "keyUp"],
      ["Input.insertText", "b"],
    ]);
  });

  it("sends Mac shortcuts to the page as editing commands", async () => {
    const { act, cdp } = computer();
    await act({ kind: "key", key: "cmd+a" });
    expect(cdp.map((call) => call.params)).toEqual([
      {
        type: "rawKeyDown",
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        modifiers: 4,
        commands: ["selectAll"],
      },
      { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4 },
    ]);
  });

  it("drags in the page and in native windows", async () => {
    const page = computer();
    await page.act(
      { kind: "pointer", x: 10, y: 400, type: "down" },
      { kind: "pointer", x: 10, y: 300, type: "move" },
      { kind: "pointer", x: 10, y: 300, type: "up" },
    );
    expect(mouse(page.cdp)).toEqual([
      ["mouseMoved", 10, 290, "none", undefined],
      ["mousePressed", 10, 290, "left", 1],
      ["mouseMoved", 10, 190, "left", undefined],
      ["mouseReleased", 10, 190, "left", 1],
    ]);
    const native = computer({ windows: [editor, chromeWindow] });
    await native.act(
      { kind: "pointer", x: 400, y: 300, type: "down" },
      { kind: "pointer", x: 500, y: 350, type: "up" },
      { kind: "pointer", x: 400, y: 300, type: "down" },
      { kind: "pointer", x: 401, y: 300, type: "up" },
    );
    expect(native.driver).toEqual([
      [
        "drag",
        { pid: 8, window_id: 568, from_x: 200, from_y: 170, to_x: 300, to_y: 220, button: "left" },
      ],
      ["click", { pid: 8, window_id: 568, x: 200, y: 170, button: "left" }],
    ]);
  });

  it("scrolls whatever is under the bot's cursor", async () => {
    const page = computer();
    await page.act(
      { kind: "pointer", x: 100, y: 400, type: "move" },
      { kind: "scroll", direction: "down", amount: 2 },
    );
    expect(page.cdp.at(-1)?.params).toEqual({
      type: "mouseWheel",
      x: 100,
      y: 290,
      deltaX: 0,
      deltaY: 200,
    });
    const native = computer({ windows: [editor, chromeWindow] });
    await native.act(
      { kind: "pointer", x: 400, y: 300, type: "move" },
      { kind: "scroll", direction: "up" },
    );
    expect(native.driver).toEqual([
      ["scroll", { pid: 8, window_id: 568, x: 200, y: 170, direction: "up", amount: 3 }],
    ]);
  });

  it("opens URLs and absolute files in the bot's Chrome window", async () => {
    const { act, cdp, driver } = computer();
    await act(
      { kind: "open", path: "https://example.com/" },
      { kind: "open", path: "/Users/joaoalves/workspace/relatório final.pdf" },
    );
    expect(cdp.map((call) => call.params.url)).toEqual([
      "https://example.com/",
      "file:///Users/joaoalves/workspace/relat%C3%B3rio%20final.pdf",
    ]);
    expect(driver).toEqual([
      ["browser", { visible: true }],
      ["browser", { visible: true }],
    ]);
    await expect(act({ kind: "open", path: "notas.txt" })).rejects.toThrow(/absolute path/);
  });

  it("raises the bot's Chrome window when another window covers it", async () => {
    const cover = { ...editor, bounds: { x: 1280, y: 30, width: 1280, height: 770 } };
    const { act, cdp, driver } = computer({ windows: [cover, chromeWindow] });
    await act({ kind: "focus", application: "chrome", uri: "https://example.com/" });
    expect(cdp.map((call) => call.method)).toEqual(["Page.navigate"]);
    expect(driver).toEqual([
      ["browser", { visible: true }],
      ["raise", { pid: 42, window: 1924 }],
    ]);
  });

  it("shows and raises the bot's Chrome window before the page browser runs", async () => {
    const cover = { ...editor, bounds: { x: 1280, y: 30, width: 1280, height: 770 } };
    const { bot, act, driver } = computer({ windows: [cover, chromeWindow] });
    const order: string[] = [];
    const typing = act({ kind: "clipboard", text: "oi" }).then(() => order.push("typed"));
    const snapshot = await bot.usePage(async () => {
      order.push("page");
      return { ok: true };
    });
    await typing;
    expect(snapshot).toEqual({ ok: true });
    expect(order).toEqual(["typed", "page"]);
    expect(driver.slice(-2)).toEqual([
      ["browser", { visible: true }],
      ["raise", { pid: 42, window: 1924 }],
    ]);
    await expect(computer({ page: false }).bot.usePage(async () => "never")).rejects.toThrow(
      "the bot's browser window is not available",
    );
  });

  it("launches native apps onto the bot's screen and types into them", async () => {
    const other = { x: 2560, y: 0, width: 1280, height: 800 };
    const { act, driver } = computer({
      others: [other],
      driver: (tool) =>
        tool === "launch_app"
          ? {
              pid: 8,
              windows: [
                { window_id: 700, pid: 8, bounds: { x: 2600, y: 100, width: 800, height: 500 } },
                {
                  window_id: 701,
                  pid: 8,
                  app_name: "TextEdit",
                  bounds: { x: 100, y: 100, width: 900, height: 600 },
                  z_index: 3,
                },
              ],
            }
          : { effect: "unverifiable" },
    });
    await act(
      { kind: "launch", application: "TextEdit" },
      { kind: "key", key: "n", modifiers: ["cmd"] },
    );
    expect(driver).toEqual([
      ["launch_app", { name: "TextEdit" }],
      ["browser", { visible: false }],
      ["set_window_frame", { pid: 8, window_id: 701, x: 1470, y: 115, width: 900, height: 600 }],
      ["raise", { pid: 8, window: 701 }],
      ["hotkey", { pid: 8, window_id: 701, keys: ["cmd", "n"] }],
    ]);
  });

  it("waits for the window of an app that starts slowly", async () => {
    let polls = 0;
    const { act, driver, sleeps } = computer({
      driver: (tool) => {
        if (tool === "launch_app") return { pid: 9, windows: [] };
        if (tool === "list_windows") {
          polls++;
          return {
            windows:
              polls < 2
                ? []
                : [{ window_id: 9, pid: 9, bounds: { x: 1300, y: 60, width: 400, height: 300 } }],
          };
        }
        return { effect: "confirmed" };
      },
    });
    await act({ kind: "focus", application: "Calculator" });
    expect(sleeps).toEqual([250, 250]);
    expect(driver.map(([tool]) => tool)).toEqual([
      "launch_app",
      "list_windows",
      "list_windows",
      "browser",
      "raise",
    ]);
  });

  it("caps waits and refuses keys when nothing on the screen can take them", async () => {
    const { act, sleeps } = computer({ page: false, windows: [] });
    await act({ kind: "wait", ms: 60_000 });
    expect(sleeps).toEqual([5_000]);
    await expect(act({ kind: "key", key: "a" })).rejects.toThrow(/no window/);
  });

  it("reports the window the bot is working in", async () => {
    const { act, bot } = computer({ windows: [editor, chromeWindow] });
    expect(await bot.activeWindow()).toEqual({ id: "1924", title: "Login de teste" });
    await act(click(400, 300));
    expect(await bot.activeWindow()).toEqual({ id: "568", title: "notas.txt" });
  });
});

describe("parseKey", () => {
  it("reads xdotool names, combos and characters", () => {
    expect(parseKey("ctrl+a")).toEqual({
      keysym: 0x61,
      driverKey: "a",
      bits: 2,
      driverModifiers: ["ctrl"],
    });
    expect(parseKey("Return")).toMatchObject({ keysym: 0xff0d, driverKey: "return" });
    expect(parseKey("Page_Down")).toMatchObject({ keysym: 0xff56, driverKey: "pagedown" });
    expect(parseKey("BackSpace")).toMatchObject({ keysym: 0xff08, driverKey: "delete" });
    expect(parseKey("Delete")).toMatchObject({ keysym: 0xffff, driverKey: "forward_delete" });
    expect(parseKey("A")).toMatchObject({
      keysym: 0x41,
      driverKey: "a",
      driverModifiers: ["shift"],
    });
    expect(parseKey("ç")).toMatchObject({ keysym: 0xe7, driverKey: "ç" });
    expect(parseKey("+")).toMatchObject({ keysym: 0x2b });
    expect(parseKey("Tab", ["super", "shift"])).toMatchObject({
      bits: 12,
      driverModifiers: ["cmd", "shift"],
    });
    expect(() => parseKey("bogus")).toThrow(/unknown key/);
    expect(() => parseKey("a", ["hyper"])).toThrow(/unknown modifier/);
  });
});

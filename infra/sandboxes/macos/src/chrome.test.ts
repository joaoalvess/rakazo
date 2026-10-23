import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { Chrome } from "./chrome.js";

interface FakeTarget {
  targetId: string;
  windowId: number;
  visible: boolean;
}

interface FakeWindow {
  left: number;
  top: number;
  width: number;
  height: number;
  windowState?: string;
}

const display = { x: 1280, y: 0, width: 1280, height: 800 };

let server: http.Server;
let sockets: WebSocketServer;
let chrome: Chrome;
let browserId: string;
let targets: FakeTarget[];
let windows: Map<number, FakeWindow>;
let calls: string[];
let nextWindow: number;
let offscreenMoves: number;
let minimized: Set<number>;
let lifecycle: Map<string, string>;

function handle(method: string, params: Record<string, unknown>, sessionId?: string) {
  calls.push(method);
  switch (method) {
    case "Target.createTarget": {
      const windowId = nextWindow++;
      windows.set(windowId, { left: 0, top: 0, width: 800, height: 600 });
      const target = { targetId: `t${targets.length + 1}`, windowId, visible: true };
      targets.push(target);
      return { targetId: target.targetId };
    }
    case "Browser.getWindowForTarget": {
      const target = targets.find((candidate) => candidate.targetId === params.targetId);
      if (!target) throw new Error("No target with given id");
      return { windowId: target.windowId, bounds: windows.get(target.windowId) };
    }
    case "Browser.getWindowBounds": {
      const window = windows.get(params.windowId as number);
      if (!window) throw new Error("Browser window not found");
      return { bounds: window };
    }
    case "Browser.setWindowBounds": {
      const window = windows.get(params.windowId as number)!;
      const bounds = params.bounds as Partial<FakeWindow> & { windowState?: string };
      if (bounds.windowState === "minimized") {
        minimized.add(params.windowId as number);
      } else if (minimized.delete(params.windowId as number)) {
        for (const target of targets) {
          if (target.windowId === params.windowId) target.visible = true;
        }
        if (bounds.windowState !== "normal") Object.assign(window, bounds);
      } else if (bounds.left !== undefined && offscreenMoves > 0) {
        offscreenMoves--;
        Object.assign(window, { ...bounds, left: 0 });
      } else if (bounds.windowState === "maximized") {
        Object.assign(window, {
          left: window.left < display.x ? 0 : display.x,
          top: display.y + 30,
          width: 1280,
          height: 770,
          windowState: "maximized",
        });
      } else {
        Object.assign(window, bounds);
      }
      return {};
    }
    case "Target.getTargets":
      return { targetInfos: targets.map(({ targetId }) => ({ targetId, type: "page" })) };
    case "Page.setWebLifecycleState": {
      const target = targets.find((candidate) => `s-${candidate.targetId}` === sessionId)!;
      lifecycle.set(target.targetId, params.state as string);
      return {};
    }
    case "Target.attachToTarget":
      return { sessionId: `s-${params.targetId}` };
    case "Runtime.evaluate": {
      const target = targets.find((candidate) => `s-${candidate.targetId}` === sessionId)!;
      const window = windows.get(target.windowId)!;
      return {
        result: {
          value: {
            visible: target.visible && !minimized.has(target.windowId),
            x: window.left,
            y: window.top,
            outerWidth: window.width,
            outerHeight: window.height,
            innerWidth: 1024,
            innerHeight: 560,
            scale: 1.25,
          },
        },
      };
    }
    case "SystemInfo.getProcessInfo":
      return {
        processInfo: [
          { type: "renderer", id: 1 },
          { type: "browser", id: 4242 },
        ],
      };
    case "Target.closeTarget":
      targets = targets.filter((target) => target.targetId !== params.targetId);
      return { success: true };
    default:
      throw new Error(`unexpected ${method}`);
  }
}

beforeEach(async () => {
  browserId = "browser-1";
  targets = [];
  windows = new Map();
  calls = [];
  nextWindow = 1;
  offscreenMoves = 0;
  minimized = new Set();
  lifecycle = new Map();
  sockets = new WebSocketServer({ noServer: true });
  server = http.createServer((_request, response) => {
    const { port } = server.address() as AddressInfo;
    response.end(
      JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/${browserId}`,
      }),
    );
  });
  server.on("upgrade", (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, (ws) => {
      ws.on("message", (data) => {
        const { id, method, params, sessionId } = JSON.parse(String(data));
        try {
          ws.send(JSON.stringify({ id, result: handle(method, params, sessionId) }));
        } catch (error) {
          ws.send(JSON.stringify({ id, error: { message: (error as Error).message } }));
        }
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  chrome = new Chrome(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});

afterEach(async () => {
  chrome.close();
  for (const client of sockets.clients) client.terminate();
  sockets.close();
  await new Promise((resolve) => server.close(resolve));
});

describe("Chrome", () => {
  it("opens a window for a bot and maximizes it on the bot's display", async () => {
    expect(await chrome.placeWindow(undefined, display)).toEqual({
      browserId: "browser-1",
      windowId: 1,
    });
    expect(windows.get(1)).toEqual({
      left: 1280,
      top: 30,
      width: 1280,
      height: 770,
      windowState: "maximized",
    });
  });

  it("keeps a window that is still on the bot's display", async () => {
    const window = await chrome.placeWindow(undefined, display);
    calls = [];
    expect(await chrome.placeWindow(window, display)).toEqual(window);
    expect(calls).toEqual(["Browser.getWindowBounds"]);
  });

  it("maximizes a window left at its normal size on the bot's display", async () => {
    const window = await chrome.placeWindow(undefined, display);
    Object.assign(windows.get(1)!, { height: 692, windowState: "normal" });
    calls = [];
    await chrome.placeWindow(window, display);
    expect(calls).toEqual(["Browser.getWindowBounds", "Browser.setWindowBounds"]);
    expect(windows.get(1)?.height).toBe(770);
  });

  it("moves a window back onto the bot's display", async () => {
    const window = await chrome.placeWindow(undefined, display);
    windows.set(1, { left: 0, top: 30, width: 1280, height: 770 });
    calls = [];
    await chrome.placeWindow(window, display);
    expect(calls.filter((call) => call === "Browser.setWindowBounds")).toHaveLength(3);
    expect(windows.get(1)?.left).toBe(1280);
  });

  it("retries while Chrome has not seen a new display yet", async () => {
    offscreenMoves = 1;
    const window = await chrome.placeWindow(undefined, display);
    expect(calls.filter((call) => call === "Browser.setWindowBounds")).toHaveLength(6);
    expect(windows.get(window.windowId)?.left).toBe(1280);
    offscreenMoves = 99;
    windows.set(window.windowId, { left: 0, top: 30, width: 1280, height: 770 });
    await expect(chrome.placeWindow(window, display)).rejects.toThrow(/off the screen/);
  });

  it("leaves a hidden window minimized until it is shown again", async () => {
    const window = await chrome.placeWindow(undefined, display);
    await chrome.hideWindow(window);
    expect(minimized.has(1)).toBe(true);
    expect(await chrome.pageView(window)).toBeUndefined();
    calls = [];
    await chrome.placeWindow(window, display);
    expect(calls).toEqual(["Browser.getWindowBounds"]);
    await chrome.placeWindow(window, display, true);
    expect(minimized.has(1)).toBe(false);
    expect(windows.get(1)?.windowState).toBe("maximized");
    expect(await chrome.pageView(window)).toBeDefined();
  });

  it("brings back a window whose pages Chrome hid without minimizing it", async () => {
    const window = await chrome.placeWindow(undefined, display);
    targets[0]!.visible = false;
    calls = [];
    await chrome.placeWindow(window, display, true);
    expect(calls.filter((call) => call === "Browser.setWindowBounds")).toHaveLength(2);
    expect(windows.get(1)?.windowState).toBe("maximized");
  });

  it("opens a new window when the window is gone or Chrome restarted", async () => {
    const window = await chrome.placeWindow(undefined, display);
    windows.delete(1);
    expect((await chrome.placeWindow(window, display)).windowId).toBe(2);
    expect(await chrome.placeWindow({ browserId: "browser-0", windowId: 2 }, display)).toEqual({
      browserId: "browser-1",
      windowId: 3,
    });
  });

  it("finds the visible page of a bot's window and its content area", async () => {
    const window = await chrome.placeWindow(undefined, display);
    targets.unshift({ targetId: "hidden", windowId: 1, visible: false });
    targets.push({ targetId: "other-bot", windowId: 9, visible: true });
    const view = await chrome.pageView(window);
    expect(view?.rect).toEqual({ x: 1280, y: 100, width: 1280, height: 700 });
    expect(view?.scale).toBe(1.25);
    expect(view?.window).toEqual({ x: 1280, y: 30, width: 1280, height: 770 });
    expect(view?.pid).toBe(4242);
    expect(await chrome.pageView({ browserId: "browser-0", windowId: 1 })).toBeUndefined();
  });

  it("freezes and thaws only the pages of a bot's window", async () => {
    const window = await chrome.placeWindow(undefined, display);
    targets.push({ targetId: "second-tab", windowId: 1, visible: false });
    targets.push({ targetId: "other-bot", windowId: 9, visible: true });
    await chrome.freezeWindow(window, true);
    expect(Object.fromEntries(lifecycle)).toEqual({ t1: "frozen", "second-tab": "frozen" });
    await chrome.freezeWindow(window, false);
    expect(Object.fromEntries(lifecycle)).toEqual({ t1: "active", "second-tab": "active" });
    await chrome.freezeWindow({ browserId: "browser-0", windowId: 1 }, true);
    expect(lifecycle.get("t1")).toBe("active");
  });

  it("closes only the pages of a bot's window", async () => {
    const window = await chrome.placeWindow(undefined, display);
    targets.push({ targetId: "second-tab", windowId: 1, visible: false });
    targets.push({ targetId: "other-bot", windowId: 9, visible: true });
    await chrome.closeWindow(window);
    expect(targets.map((target) => target.targetId)).toEqual(["other-bot"]);
  });
});

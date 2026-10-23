import path from "node:path";
import { pathToFileURL } from "node:url";
import { BROWSER_APPLICATIONS } from "@rakazo/core/node/desktop-runtime";
import type { PageView } from "./chrome.js";
import type { Rect, WindowInfo } from "./displayd.js";
import { DriverError, type DriverResult } from "./driver.js";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "./screens.js";
import { contains, onPage, pageKey, sameRect } from "./takeover.js";

export interface Point {
  x: number;
  y: number;
}

type Button = "left" | "right";
type PointerAction = {
  kind: "pointer";
  x: number;
  y: number;
  button?: Button;
  type: "move" | "down" | "up" | "click";
};

export type ComputerAction =
  | { kind: "key"; key: string; modifiers?: string[] }
  | PointerAction
  | { kind: "clipboard"; text: string }
  | { kind: "scroll"; direction: "up" | "down"; amount?: number }
  | { kind: "wait"; ms: number }
  | { kind: "open"; path: string }
  | { kind: "launch"; application: string; uri?: string }
  | { kind: "focus"; application: string; uri?: string };

export interface BotTargets {
  display(): Promise<Rect>;
  otherDisplays(): Promise<Rect[]>;
  page(): Promise<PageView | undefined>;
  windows(): Promise<WindowInfo[]>;
  driver(tool: string, args: Record<string, unknown>): Promise<DriverResult>;
  raise(pid: number, window: number): Promise<unknown>;
  foreground<T>(work: () => Promise<T>): Promise<T>;
  browser(visible: boolean): Promise<unknown>;
  overlay(update: { cursor?: Point; click?: Point; typing?: boolean }): Promise<unknown>;
}

type PageTarget = { kind: "page"; page: PageView; display: Rect; x: number; y: number };
type NativeTarget = { kind: "native"; window: WindowInfo; display: Rect; x: number; y: number };
type Target = PageTarget | NativeTarget;
type Focus = { kind: "page" } | { kind: "native"; window: WindowInfo };

interface DriverWindow {
  window_id: number;
  pid: number;
  app_name?: string;
  title?: string;
  bounds: Rect;
  z_index?: number | null;
  is_on_screen?: boolean;
}

const MOUSE_BUTTONS = { none: 0, left: 1, right: 2 } as const;
const ENTER = 0xff0d;
const SCROLL_STEP = 100;
const DRAG_PX = 3;
const MAX_WAIT_MS = 5_000;
const MENU_BAR_HEIGHT = 30;
const WINDOW_POLL_MS = 250;
const WINDOW_POLLS = 12;
const KEYBOARD_AMBIGUITY = "same_pid_keyboard_ambiguity";
const BROWSERS = new Set([...BROWSER_APPLICATIONS, "google chrome"]);

const MODIFIERS = new Map<string, { bit: number; driver: string }>([
  ["alt", { bit: 1, driver: "option" }],
  ["option", { bit: 1, driver: "option" }],
  ["ctrl", { bit: 2, driver: "ctrl" }],
  ["control", { bit: 2, driver: "ctrl" }],
  ["cmd", { bit: 4, driver: "cmd" }],
  ["command", { bit: 4, driver: "cmd" }],
  ["meta", { bit: 4, driver: "cmd" }],
  ["super", { bit: 4, driver: "cmd" }],
  ["shift", { bit: 8, driver: "shift" }],
]);

const NAMED_KEYS = new Map<string, { keysym: number; driver: string }>([
  ["enter", { keysym: ENTER, driver: "return" }],
  ["return", { keysym: ENTER, driver: "return" }],
  ["kpenter", { keysym: 0xff8d, driver: "return" }],
  ["tab", { keysym: 0xff09, driver: "tab" }],
  ["escape", { keysym: 0xff1b, driver: "escape" }],
  ["esc", { keysym: 0xff1b, driver: "escape" }],
  ["backspace", { keysym: 0xff08, driver: "delete" }],
  ["delete", { keysym: 0xffff, driver: "forward_delete" }],
  ["del", { keysym: 0xffff, driver: "forward_delete" }],
  ["home", { keysym: 0xff50, driver: "home" }],
  ["end", { keysym: 0xff57, driver: "end" }],
  ["pageup", { keysym: 0xff55, driver: "pageup" }],
  ["prior", { keysym: 0xff55, driver: "pageup" }],
  ["pagedown", { keysym: 0xff56, driver: "pagedown" }],
  ["next", { keysym: 0xff56, driver: "pagedown" }],
  ["left", { keysym: 0xff51, driver: "left" }],
  ["arrowleft", { keysym: 0xff51, driver: "left" }],
  ["up", { keysym: 0xff52, driver: "up" }],
  ["arrowup", { keysym: 0xff52, driver: "up" }],
  ["right", { keysym: 0xff53, driver: "right" }],
  ["arrowright", { keysym: 0xff53, driver: "right" }],
  ["down", { keysym: 0xff54, driver: "down" }],
  ["arrowdown", { keysym: 0xff54, driver: "down" }],
  ["space", { keysym: 0x20, driver: "space" }],
  ...Array.from({ length: 12 }, (_, index): [string, { keysym: number; driver: string }] => [
    `f${index + 1}`,
    { keysym: 0xffbe + index, driver: `f${index + 1}` },
  ]),
]);

export function parseKey(key: string, modifiers: string[] = []) {
  const parts = key.length > 1 ? key.split("+") : [key];
  const name = parts.pop() || "+";
  let bits = 0;
  const driverModifiers: string[] = [];
  const hold = (modifier: { bit: number; driver: string }) => {
    if (bits & modifier.bit) return;
    bits |= modifier.bit;
    driverModifiers.push(modifier.driver);
  };
  for (const modifier of [...modifiers, ...parts]) {
    const known = MODIFIERS.get(modifier.trim().toLowerCase());
    if (!known) throw new Error(`unknown modifier ${modifier}`);
    hold(known);
  }
  const named = NAMED_KEYS.get(name.toLowerCase().replaceAll("_", ""));
  if (named) return { keysym: named.keysym, driverKey: named.driver, bits, driverModifiers };
  if ([...name].length !== 1) throw new Error(`unknown key ${name}`);
  if (name !== name.toLowerCase()) hold(MODIFIERS.get("shift")!);
  const codePoint = name.codePointAt(0)!;
  return {
    keysym: codePoint <= 0xff ? codePoint : 0x01000000 + codePoint,
    driverKey: name.toLowerCase(),
    bits,
    driverModifiers,
  };
}

export class BotComputer {
  private queue: Promise<unknown> = Promise.resolve();
  private cursor: Point = { x: SCREEN_WIDTH / 2, y: SCREEN_HEIGHT / 2 };
  private focus?: Focus;
  private held?: { target: Target; from: Point; button: Button };

  constructor(
    private readonly targets: BotTargets,
    private readonly sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {}

  get position(): Point {
    return { ...this.cursor };
  }

  act(actions: ComputerAction[]): Promise<number> {
    const run = this.queue.then(() => this.run(actions));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async activeWindow() {
    const windows = await this.targets.windows();
    const focus = this.focus;
    let window =
      focus?.kind === "native"
        ? windows.find((candidate) => candidate.id === focus.window.id)
        : undefined;
    if (!window) {
      const page = await this.targets.page().catch(() => undefined);
      window = page && windows.find((candidate) => isPageWindow(candidate, page));
    }
    window ??= windows[0];
    return window && { id: String(window.id), ...(window.title ? { title: window.title } : {}) };
  }

  private async run(actions: ComputerAction[]) {
    for (let index = 0; index < actions.length; index++) {
      const action = actions[index]!;
      if (action.kind === "pointer" && action.type === "click") {
        let count = 1;
        while (count < 3 && sameClick(actions[index + count], action)) count++;
        await this.click(action, count);
        index += count - 1;
      } else {
        await this.step(action);
      }
    }
    return actions.length;
  }

  private async step(action: ComputerAction) {
    switch (action.kind) {
      case "pointer":
        if (action.type === "move") return this.move(action);
        if (action.type === "down") return this.down(action);
        if (action.type === "up") return this.up(action);
        return this.click(action, 1);
      case "key":
        return this.key(action.key, action.modifiers);
      case "clipboard":
        return this.type(action.text);
      case "scroll":
        return this.scroll(action.direction, action.amount);
      case "wait":
        return this.sleep(Math.min(Math.max(action.ms, 0), MAX_WAIT_MS));
      case "open":
        return this.open(action.path);
      default:
        return this.focusApplication(action.application, action.uri);
    }
  }

  private async click(action: PointerAction, count: number) {
    const point = this.point(action, true);
    const target = await this.targetAt(point);
    if (!target) return;
    const button = action.button ?? "left";
    this.focus = focusOf(target);
    if (target.kind === "native") {
      await this.targets.driver("click", {
        ...nativeArgs(target),
        button,
        ...(count > 1 ? { count } : {}),
      });
      return;
    }
    await mouse(target, "mouseMoved", "none", 0);
    for (let clickCount = 1; clickCount <= count; clickCount++) {
      await mouse(target, "mousePressed", button, MOUSE_BUTTONS[button], clickCount);
      await mouse(target, "mouseReleased", button, 0, clickCount);
    }
  }

  private async move(action: PointerAction) {
    const point = this.point(action);
    const held = this.held;
    if (held) {
      if (held.target.kind === "page") {
        await mouse(at(held.target, point), "mouseMoved", held.button, MOUSE_BUTTONS[held.button]);
      }
      return;
    }
    const target = await this.targetAt(point);
    if (target?.kind === "page") await mouse(target, "mouseMoved", "none", 0);
  }

  private async down(action: PointerAction) {
    const point = this.point(action, true);
    const target = await this.targetAt(point);
    if (!target) return;
    const button = action.button ?? "left";
    this.focus = focusOf(target);
    this.held = { target, from: point, button };
    if (target.kind === "page") {
      await mouse(target, "mouseMoved", "none", 0);
      await mouse(target, "mousePressed", button, MOUSE_BUTTONS[button], 1);
    }
  }

  private async up(action: PointerAction) {
    const point = this.point(action);
    const held = this.held;
    this.held = undefined;
    if (!held) return;
    const target = at(held.target, point);
    if (target.kind === "page") {
      await mouse(target, "mouseReleased", held.button, 0, 1);
    } else if (Math.hypot(point.x - held.from.x, point.y - held.from.y) <= DRAG_PX) {
      await this.targets.driver("click", {
        ...nativeArgs(held.target as NativeTarget),
        button: held.button,
      });
    } else {
      await this.targets.driver("drag", {
        pid: target.window.pid,
        window_id: target.window.id,
        from_x: held.target.x,
        from_y: held.target.y,
        to_x: target.x,
        to_y: target.y,
        button: held.button,
      });
    }
  }

  private async key(key: string, modifiers?: string[]) {
    const parsed = parseKey(key, modifiers);
    const target = await this.typingTarget();
    if (target.kind === "native") {
      const window = { pid: target.window.pid, window_id: target.window.id };
      if (parsed.driverModifiers.length) {
        await this.keyboard("hotkey", {
          ...window,
          keys: [...parsed.driverModifiers, parsed.driverKey],
        });
      } else {
        await this.keyboard("press_key", { ...window, key: parsed.driverKey });
      }
      return;
    }
    await pressPageKey(target.page, parsed.keysym, parsed.bits);
  }

  private async type(text: string) {
    const target = await this.typingTarget();
    this.show({ typing: true });
    try {
      if (target.kind === "native") {
        await this.keyboard("type_text", {
          pid: target.window.pid,
          window_id: target.window.id,
          text,
        });
        return;
      }
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (index > 0) await pressPageKey(target.page, ENTER, 0);
        if (line) await target.page.send("Input.insertText", { text: line });
      }
    } finally {
      this.show({ typing: false });
    }
  }

  private async keyboard(
    tool: "press_key" | "hotkey" | "type_text",
    args: Record<string, unknown>,
  ) {
    try {
      await this.targets.driver(tool, args);
    } catch (error) {
      if (!(error instanceof DriverError) || error.code !== KEYBOARD_AMBIGUITY) throw error;
      const window = { pid: args.pid, window_id: args.window_id };
      await this.targets.foreground(async () => {
        await this.targets.raise(window.pid as number, window.window_id as number);
        await this.targets.driver("bring_to_front", window);
        await this.targets.driver(tool, { ...args, delivery_mode: "foreground" });
      });
    }
  }

  private async scroll(direction: "up" | "down", amount = 3) {
    const notches = Math.min(Math.max(Math.round(amount), 1), 20);
    const target = await this.targetAt(this.cursor);
    if (!target) return;
    if (target.kind === "native") {
      await this.targets.driver("scroll", { ...nativeArgs(target), direction, amount: notches });
      return;
    }
    await target.page.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: target.x,
      y: target.y,
      deltaX: 0,
      deltaY: (direction === "up" ? -1 : 1) * notches * SCROLL_STEP,
    });
  }

  private async open(location: string) {
    if (/^https?:\/\//i.test(location)) return this.browse(location);
    if (!path.isAbsolute(location))
      throw new Error("open needs an http(s) URL or an absolute path");
    return this.browse(pathToFileURL(location).href);
  }

  private async browse(url?: string) {
    await this.targets.browser(true);
    const page = await this.targets.page();
    if (!page) throw new Error("the bot's browser window is not available");
    if (url) await page.send("Page.navigate", { url });
    this.focus = { kind: "page" };
    const windows = await this.targets.windows();
    const window = windows.find((candidate) => isPageWindow(candidate, page));
    const centerX = page.rect.x + page.rect.width / 2;
    const centerY = page.rect.y + page.rect.height / 2;
    if (window && !onPage(page, windows, centerX, centerY)) {
      await this.targets.raise(window.pid, window.id);
    }
  }

  private async focusApplication(application: string, uri?: string) {
    if (BROWSERS.has(application.trim().toLowerCase())) return this.browse(uri);
    const launched = (await this.targets.driver("launch_app", {
      name: application,
      ...(uri ? { urls: [uri] } : {}),
    })) as { pid?: number; windows?: DriverWindow[] };
    const pid = launched.pid;
    if (!pid) throw new Error(`${application} did not start`);
    const [display, others] = await Promise.all([
      this.targets.display(),
      this.targets.otherDisplays(),
    ]);
    const window = await this.appWindow(pid, launched.windows ?? [], display, others);
    if (!window) return;
    await this.targets.browser(false);
    let bounds = window.bounds;
    if (!intersects(bounds, display)) {
      bounds = fitInto(bounds, display);
      await this.targets.driver("set_window_frame", {
        pid,
        window_id: window.window_id,
        ...bounds,
      });
    }
    await this.targets.raise(pid, window.window_id);
    this.focus = {
      kind: "native",
      window: {
        id: window.window_id,
        owner: window.app_name ?? application,
        ...(window.title ? { title: window.title } : {}),
        pid,
        layer: 0,
        bounds,
      },
    };
  }

  private async appWindow(pid: number, windows: DriverWindow[], display: Rect, others: Rect[]) {
    for (let poll = 0; ; poll++) {
      const [window] = windows
        .filter(
          (candidate) =>
            candidate.is_on_screen !== false &&
            !others.some((other) => intersects(candidate.bounds, other)),
        )
        .sort(
          (a, b) =>
            Number(intersects(b.bounds, display)) - Number(intersects(a.bounds, display)) ||
            (b.z_index ?? 0) - (a.z_index ?? 0),
        );
      if (window || poll >= WINDOW_POLLS) return window;
      await this.sleep(WINDOW_POLL_MS);
      const listed = (await this.targets.driver("list_windows", { pid })) as {
        windows?: DriverWindow[];
      };
      windows = listed.windows ?? [];
    }
  }

  private async typingTarget(): Promise<
    { kind: "page"; page: PageView } | Extract<Focus, { kind: "native" }>
  > {
    const focus = this.focus;
    if (focus?.kind === "native") return focus;
    const page = await this.targets.page().catch(() => undefined);
    if (page) return { kind: "page", page };
    if (focus?.kind === "page") throw new Error("the bot's browser page is not available");
    const [window] = await this.targets.windows();
    if (!window)
      throw new Error("no window on this screen takes keyboard input; open or click one first");
    return { kind: "native", window };
  }

  private async targetAt(point: Point): Promise<Target | undefined> {
    const [display, page, windows] = await Promise.all([
      this.targets.display(),
      this.targets.page().catch(() => undefined),
      this.targets.windows(),
    ]);
    const x = display.x + point.x;
    const y = display.y + point.y;
    if (page && onPage(page, windows, x, y))
      return at({ kind: "page", page, display, x: 0, y: 0 }, point);
    const window = windows.find((candidate) => contains(candidate.bounds, x, y));
    return window && at({ kind: "native", window, display, x: 0, y: 0 }, point);
  }

  private point(action: PointerAction, click = false) {
    const point = {
      x: Math.min(Math.max(Math.round(action.x), 0), SCREEN_WIDTH - 1),
      y: Math.min(Math.max(Math.round(action.y), 0), SCREEN_HEIGHT - 1),
    };
    this.cursor = point;
    this.show({ cursor: point, ...(click ? { click: point } : {}) });
    return point;
  }

  private show(update: { cursor?: Point; click?: Point; typing?: boolean }) {
    void this.targets.overlay(update).catch(() => undefined);
  }
}

function at<T extends Target>(target: T, point: Point): T {
  const x = target.display.x + point.x;
  const y = target.display.y + point.y;
  if (target.kind === "page") {
    const { rect, scale } = (target as PageTarget).page;
    return { ...target, x: (x - rect.x) / scale, y: (y - rect.y) / scale };
  }
  const { bounds } = (target as NativeTarget).window;
  return { ...target, x: x - bounds.x, y: y - bounds.y };
}

function mouse(
  target: PageTarget,
  type: "mouseMoved" | "mousePressed" | "mouseReleased",
  button: Button | "none",
  buttons: number,
  clickCount?: number,
) {
  return target.page.send("Input.dispatchMouseEvent", {
    type,
    x: target.x,
    y: target.y,
    button,
    buttons,
    ...(clickCount ? { clickCount } : {}),
  });
}

async function pressPageKey(page: PageView, keysym: number, modifiers: number) {
  const events = [...pageKey(keysym, true, modifiers), ...pageKey(keysym, false, modifiers)];
  if (!events.length) throw new Error(`the page cannot take key ${keysym.toString(16)}`);
  for (const params of events) await page.send("Input.dispatchKeyEvent", params);
}

function nativeArgs(target: NativeTarget) {
  return { pid: target.window.pid, window_id: target.window.id, x: target.x, y: target.y };
}

function focusOf(target: Target): Focus {
  return target.kind === "page" ? { kind: "page" } : { kind: "native", window: target.window };
}

function isPageWindow(window: WindowInfo, page: PageView) {
  return window.pid === page.pid && sameRect(window.bounds, page.window);
}

function sameClick(next: ComputerAction | undefined, click: PointerAction) {
  return (
    next?.kind === "pointer" &&
    next.type === "click" &&
    next.x === click.x &&
    next.y === click.y &&
    (next.button ?? "left") === (click.button ?? "left")
  );
}

function intersects(a: Rect, b: Rect) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function fitInto(bounds: Rect, display: Rect): Rect {
  const width = Math.min(bounds.width, display.width);
  const height = Math.min(bounds.height, display.height - MENU_BAR_HEIGHT);
  return {
    x: display.x + Math.round((display.width - width) / 2),
    y: display.y + MENU_BAR_HEIGHT + Math.round((display.height - MENU_BAR_HEIGHT - height) / 2),
    width,
    height,
  };
}

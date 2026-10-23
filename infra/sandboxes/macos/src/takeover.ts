import type { PageView } from "./chrome.js";
import type { InputEvent, Rect, WindowInfo } from "./displayd.js";

export interface TakeoverTargets {
  display(): Promise<Rect>;
  page(): Promise<PageView | undefined>;
  windows(): Promise<WindowInfo[]>;
  native(events: InputEvent[]): Promise<unknown>;
}

type Route = "page" | "native";
type PointerEvent = Extract<InputEvent, { t: "p" }>;

interface KeyInfo {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const STALE_MS = 500;
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_PX = 4;
const WHEEL_STEP = 50;
const BUTTON_MASK = 7;
const DOCK_EDGE_PX = 2;

const BUTTONS = [
  { bit: 1, name: "left", pressed: 1 },
  { bit: 2, name: "middle", pressed: 4 },
  { bit: 4, name: "right", pressed: 2 },
] as const;

const WHEEL = [
  { bit: 8, deltaX: 0, deltaY: -WHEEL_STEP },
  { bit: 16, deltaX: 0, deltaY: WHEEL_STEP },
  { bit: 32, deltaX: -WHEEL_STEP, deltaY: 0 },
  { bit: 64, deltaX: WHEEL_STEP, deltaY: 0 },
] as const;

const MODIFIERS = new Map([
  [0xffe9, 1],
  [0xffea, 1],
  [0xffe3, 2],
  [0xffe4, 2],
  [0xffe7, 4],
  [0xffe8, 4],
  [0xffe1, 8],
  [0xffe2, 8],
]);
const MODIFIER_NAMES = [
  [1, "Alt"],
  [2, "Control"],
  [4, "Meta"],
  [8, "Shift"],
] as const;

const KEYS = new Map<number, KeyInfo>([
  [0xff08, { key: "Backspace", code: "Backspace", keyCode: 8 }],
  [0xff09, { key: "Tab", code: "Tab", keyCode: 9 }],
  [0xff0d, { key: "Enter", code: "Enter", keyCode: 13, text: "\r" }],
  [0xff8d, { key: "Enter", code: "NumpadEnter", keyCode: 13, text: "\r" }],
  [0xff1b, { key: "Escape", code: "Escape", keyCode: 27 }],
  [0xff50, { key: "Home", code: "Home", keyCode: 36 }],
  [0xff51, { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }],
  [0xff52, { key: "ArrowUp", code: "ArrowUp", keyCode: 38 }],
  [0xff53, { key: "ArrowRight", code: "ArrowRight", keyCode: 39 }],
  [0xff54, { key: "ArrowDown", code: "ArrowDown", keyCode: 40 }],
  [0xff55, { key: "PageUp", code: "PageUp", keyCode: 33 }],
  [0xff56, { key: "PageDown", code: "PageDown", keyCode: 34 }],
  [0xff57, { key: "End", code: "End", keyCode: 35 }],
  [0xffff, { key: "Delete", code: "Delete", keyCode: 46 }],
  [0xffe1, { key: "Shift", code: "ShiftLeft", keyCode: 16 }],
  [0xffe2, { key: "Shift", code: "ShiftRight", keyCode: 16 }],
  [0xffe3, { key: "Control", code: "ControlLeft", keyCode: 17 }],
  [0xffe4, { key: "Control", code: "ControlRight", keyCode: 17 }],
  [0xffe7, { key: "Meta", code: "MetaLeft", keyCode: 91 }],
  [0xffe8, { key: "Meta", code: "MetaRight", keyCode: 93 }],
  [0xffe9, { key: "Alt", code: "AltLeft", keyCode: 18 }],
  [0xffea, { key: "Alt", code: "AltRight", keyCode: 18 }],
  ...Array.from({ length: 12 }, (_, index): [number, KeyInfo] => [
    0xffbe + index,
    { key: `F${index + 1}`, code: `F${index + 1}`, keyCode: 112 + index },
  ]),
]);

const MAC_COMMANDS = new Map([
  ["Meta+KeyA", "selectAll"],
  ["Meta+KeyC", "copy"],
  ["Meta+KeyX", "cut"],
  ["Meta+KeyV", "paste"],
  ["Meta+KeyZ", "undo"],
  ["Meta+Shift+KeyZ", "redo"],
  ["Meta+ArrowLeft", "moveToBeginningOfLine"],
  ["Meta+ArrowRight", "moveToEndOfLine"],
  ["Meta+ArrowUp", "moveToBeginningOfDocument"],
  ["Meta+ArrowDown", "moveToEndOfDocument"],
  ["Meta+Shift+ArrowLeft", "moveToBeginningOfLineAndModifySelection"],
  ["Meta+Shift+ArrowRight", "moveToEndOfLineAndModifySelection"],
  ["Meta+Shift+ArrowUp", "moveToBeginningOfDocumentAndModifySelection"],
  ["Meta+Shift+ArrowDown", "moveToEndOfDocumentAndModifySelection"],
  ["Alt+ArrowLeft", "moveWordLeft"],
  ["Alt+ArrowRight", "moveWordRight"],
  ["Alt+Shift+ArrowLeft", "moveWordLeftAndModifySelection"],
  ["Alt+Shift+ArrowRight", "moveWordRightAndModifySelection"],
  ["Meta+Backspace", "deleteToBeginningOfLine"],
  ["Alt+Backspace", "deleteWordBackward"],
  ["Alt+Delete", "deleteWordForward"],
]);

export function pageKey(keysym: number, down: boolean, modifiers: number) {
  const special = KEYS.get(keysym);
  const char = special ? undefined : keysymText(keysym);
  if (!special && !char) return [];
  const key = special?.key ?? char!;
  const code = special?.code ?? charCode(char!);
  const event = {
    key,
    ...(code ? { code } : {}),
    windowsVirtualKeyCode: special?.keyCode ?? charKeyCode(char!),
    modifiers,
  };
  if (!down) return [{ type: "keyUp", ...event }];
  const text = modifiers & 6 ? undefined : (special?.text ?? char);
  const command = MAC_COMMANDS.get(
    [...MODIFIER_NAMES.filter(([bit]) => modifiers & bit).map(([, name]) => name), code].join("+"),
  );
  return [
    {
      type: text ? "keyDown" : "rawKeyDown",
      ...event,
      ...(text ? { text, unmodifiedText: text } : {}),
      ...(command ? { commands: [command] } : {}),
    },
  ];
}

function keysymText(keysym: number) {
  if ((keysym >= 0x20 && keysym <= 0x7e) || (keysym >= 0xa0 && keysym <= 0xff)) {
    return String.fromCharCode(keysym);
  }
  if ((keysym & 0xff000000) === 0x01000000) return String.fromCodePoint(keysym & 0xffffff);
  return undefined;
}

function charCode(char: string) {
  if (/^[a-z]$/i.test(char)) return `Key${char.toUpperCase()}`;
  if (/^[0-9]$/.test(char)) return `Digit${char}`;
  return char === " " ? "Space" : "";
}

function charKeyCode(char: string) {
  return /^[a-z0-9 ]$/i.test(char) ? char.toUpperCase().charCodeAt(0) : 0;
}

function contains(rect: Rect, x: number, y: number) {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function sameRect(a: Rect, b: Rect) {
  return (
    Math.abs(a.x - b.x) <= 2 &&
    Math.abs(a.y - b.y) <= 2 &&
    Math.abs(a.width - b.width) <= 2 &&
    Math.abs(a.height - b.height) <= 2
  );
}

export class TakeoverInput {
  private queue = Promise.resolve();
  private view?: { display: Rect; page?: PageView; windows?: WindowInfo[]; at: number };
  private mask = 0;
  private last?: PointerEvent;
  private pointerRoute: Route = "native";
  private keyRoute?: Route;
  private readonly keys = new Map<number, Route>();
  private lastPress?: { button: string; x: number; y: number; at: number; count: number };
  private native: InputEvent[] = [];

  constructor(
    private readonly targets: TakeoverTargets,
    private readonly onError: (error: Error) => void,
    private readonly now: () => number = Date.now,
  ) {}

  send(events: InputEvent[]) {
    this.enqueue(async () => {
      for (const event of events) {
        if (event.t === "p") await this.pointer(event);
        else if (event.t === "k") await this.key(event);
        else await this.text(event.s);
      }
      await this.flushNative();
    });
  }

  release() {
    this.enqueue(async () => {
      for (const [keysym, route] of this.keys) {
        if (route !== "page") continue;
        for (const params of pageKey(keysym, false, 0)) {
          await this.dispatch("Input.dispatchKeyEvent", params);
        }
      }
      this.keys.clear();
      if (this.pointerRoute === "page" && this.mask & BUTTON_MASK && this.last) {
        await this.pagePointer({ ...this.last, m: 0 });
      }
      this.mask = 0;
    });
  }

  private enqueue(task: () => Promise<void>) {
    this.queue = this.queue.then(task).catch((error) => {
      this.native = [];
      this.onError(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private async pointer(event: PointerEvent) {
    if (!(this.mask & BUTTON_MASK)) {
      const pressing = (event.m & BUTTON_MASK) !== 0;
      if (pressing || !this.view || this.now() - this.view.at > STALE_MS) await this.refresh();
      this.pointerRoute = this.inPage(event) ? "page" : "native";
      if (pressing) this.keyRoute = this.pointerRoute;
    }
    if (this.pointerRoute === "native") {
      const bottom = (this.view?.display.height ?? Number.POSITIVE_INFINITY) - DOCK_EDGE_PX;
      this.native.push({ ...event, y: Math.min(event.y, bottom) });
    } else {
      await this.pagePointer(event);
    }
    this.mask = event.m;
    this.last = event;
  }

  private async pagePointer(event: PointerEvent) {
    await this.flushNative();
    const view = this.view;
    if (!view?.page) return;
    const { display, page } = view;
    const x = (display.x + event.x - page.rect.x) / page.scale;
    const y = (display.y + event.y - page.rect.y) / page.scale;
    const modifiers = this.modifiers();
    const buttons = BUTTONS.reduce(
      (sum, button) => (event.m & button.bit ? sum + button.pressed : sum),
      0,
    );
    const changed = event.m ^ this.mask;
    let sent = false;
    for (const button of BUTTONS) {
      if (!(changed & button.bit)) continue;
      const down = (event.m & button.bit) !== 0;
      await this.dispatch("Input.dispatchMouseEvent", {
        type: down ? "mousePressed" : "mouseReleased",
        x,
        y,
        button: button.name,
        buttons,
        modifiers,
        clickCount: down ? this.click(button.name, x, y) : (this.lastPress?.count ?? 1),
      });
      sent = true;
    }
    for (const wheel of WHEEL) {
      if (!(changed & wheel.bit) || !(event.m & wheel.bit)) continue;
      await this.dispatch("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: wheel.deltaX,
        deltaY: wheel.deltaY,
        modifiers,
      });
      sent = true;
    }
    if (sent) return;
    await this.dispatch("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: BUTTONS.find((button) => event.m & button.bit)?.name ?? "none",
      buttons,
      modifiers,
    });
  }

  private async key(event: Extract<InputEvent, { t: "k" }>) {
    let route: Route;
    if (event.d) {
      route = await this.keyTarget();
      this.keys.set(event.s, route);
    } else {
      route = this.keys.get(event.s) ?? "native";
      this.keys.delete(event.s);
    }
    if (route === "native") {
      this.native.push(event);
      return;
    }
    await this.flushNative();
    for (const params of pageKey(event.s, event.d, this.modifiers())) {
      await this.dispatch("Input.dispatchKeyEvent", params);
    }
  }

  private async text(text: string) {
    if ((await this.keyTarget()) === "native") {
      this.native.push({ t: "text", s: text });
      return;
    }
    await this.flushNative();
    await this.dispatch("Input.insertText", { text });
  }

  private async keyTarget() {
    if (!this.keyRoute) {
      await this.refresh();
      this.keyRoute = this.view?.page ? "page" : "native";
    }
    return this.keyRoute;
  }

  private inPage(event: PointerEvent) {
    const page = this.view?.page;
    if (!page || !this.view) return false;
    const x = this.view.display.x + event.x;
    const y = this.view.display.y + event.y;
    if (!contains(page.rect, x, y)) return false;
    const windows = this.view.windows;
    if (!windows) return true;
    const top = windows.find((window) => contains(window.bounds, x, y));
    return top?.pid === page.pid && sameRect(top.bounds, page.window);
  }

  private modifiers() {
    let modifiers = 0;
    for (const keysym of this.keys.keys()) modifiers |= MODIFIERS.get(keysym) ?? 0;
    return modifiers;
  }

  private click(button: string, x: number, y: number) {
    const now = this.now();
    const last = this.lastPress;
    const count =
      last &&
      last.button === button &&
      now - last.at < DOUBLE_CLICK_MS &&
      Math.abs(last.x - x) <= DOUBLE_CLICK_PX &&
      Math.abs(last.y - y) <= DOUBLE_CLICK_PX
        ? last.count + 1
        : 1;
    this.lastPress = { button, x, y, at: now, count };
    return count;
  }

  private async refresh() {
    const [display, page, windows] = await Promise.all([
      this.targets.display(),
      this.targets.page().catch((error: Error) => {
        this.onError(error);
        return undefined;
      }),
      this.targets.windows().catch((error: Error) => {
        this.onError(error);
        return undefined;
      }),
    ]);
    this.view = { display, page, windows, at: this.now() };
  }

  private async dispatch(method: string, params: object) {
    if (!this.view?.page) await this.refresh();
    const page = this.view?.page;
    if (!page) return;
    await page.send(method, params).catch((error: Error) => {
      this.view = undefined;
      this.onError(error);
    });
  }

  private async flushNative() {
    if (!this.native.length) return;
    const events = this.native;
    this.native = [];
    await this.targets.native(events).catch((error: Error) => this.onError(error));
  }
}

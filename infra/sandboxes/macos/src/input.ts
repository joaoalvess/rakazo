import type { InputEvent } from "./displayd.js";
import type { ClientEvent } from "./rfb.js";

const CONTROL_L = 0xffe3;
const KEY_V = 0x76;
const PASTE_CHORD: ReadonlyArray<readonly [number, boolean]> = [
  [CONTROL_L, true],
  [KEY_V, true],
  [KEY_V, false],
  [CONTROL_L, false],
];
const PASTE_CHORD_MS = 2_000;

export const MAC_CLIENT_KEYSYMS: ReadonlyMap<number, number> = new Map([
  [0xffe9, 0xffe7],
  [0xffea, 0xffe8],
  [0xff7e, 0xffe9],
  [0xfe03, 0xffea],
]);

export class ControlInput {
  private pending: InputEvent[] = [];
  private scheduled = false;
  private chord = PASTE_CHORD.length;
  private chordUntil = 0;

  constructor(
    private readonly flush: (events: InputEvent[]) => void,
    private readonly now: () => number = Date.now,
  ) {}

  handle(event: ClientEvent) {
    if (event.type === "pointer") {
      this.push({ t: "p", x: event.x, y: event.y, m: event.mask });
      return;
    }
    if (event.type === "cut") {
      if (event.text) this.push({ t: "text", s: event.text });
      this.chord = 0;
      this.chordUntil = this.now() + PASTE_CHORD_MS;
      return;
    }
    if (event.type !== "key" || this.swallow(event.keysym, event.down)) return;
    this.push({ t: "k", s: MAC_CLIENT_KEYSYMS.get(event.keysym) ?? event.keysym, d: event.down });
  }

  private swallow(keysym: number, down: boolean) {
    const expected = PASTE_CHORD[this.chord];
    if (!expected || this.now() > this.chordUntil) return false;
    if (expected[0] === keysym && expected[1] === down) {
      this.chord += 1;
      return true;
    }
    this.chord = PASTE_CHORD.length;
    return false;
  }

  private push(event: InputEvent) {
    const last = this.pending.at(-1);
    if (event.t === "p" && last?.t === "p" && last.m === event.m) {
      this.pending[this.pending.length - 1] = event;
    } else {
      this.pending.push(event);
    }
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      const events = this.pending;
      this.pending = [];
      if (events.length) this.flush(events);
    });
  }
}

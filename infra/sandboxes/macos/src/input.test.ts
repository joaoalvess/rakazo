import { describe, expect, it } from "vitest";
import type { InputEvent } from "./displayd.js";
import { ControlInput } from "./input.js";
import type { ClientEvent } from "./rfb.js";

function control(start = 0) {
  let clock = start;
  const batches: InputEvent[][] = [];
  const input = new ControlInput(
    (events) => batches.push(events),
    () => clock,
  );
  return {
    batches,
    send: (...events: ClientEvent[]) => {
      for (const event of events) input.handle(event);
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const flushed = () => new Promise((resolve) => setImmediate(resolve));
const key = (keysym: number, down: boolean): ClientEvent => ({ type: "key", keysym, down });
const pasteChord = [key(0xffe3, true), key(0x76, true), key(0x76, false), key(0xffe3, false)];

describe("ControlInput", () => {
  it("batches events and keeps only the last move of a drag", async () => {
    const { batches, send } = control();
    send(
      { type: "pointer", mask: 0, x: 1, y: 1 },
      { type: "pointer", mask: 0, x: 2, y: 2 },
      { type: "pointer", mask: 1, x: 3, y: 3 },
      { type: "pointer", mask: 1, x: 4, y: 4 },
      { type: "pointer", mask: 1, x: 5, y: 5 },
      { type: "pointer", mask: 0, x: 5, y: 5 },
    );
    expect(batches).toEqual([]);
    await flushed();
    expect(batches).toEqual([
      [
        { t: "p", x: 2, y: 2, m: 0 },
        { t: "p", x: 5, y: 5, m: 1 },
        { t: "p", x: 5, y: 5, m: 0 },
      ],
    ]);
  });

  it("maps the Mac client's Command and Option keys back to the Mac's", async () => {
    const { batches, send } = control();
    send(
      key(0xffe9, true),
      key(0xffea, true),
      key(0xff7e, true),
      key(0xfe03, true),
      key(0x61, true),
    );
    await flushed();
    expect(batches[0]?.map((event) => (event.t === "k" ? event.s : undefined))).toEqual([
      0xffe7, 0xffe8, 0xffe9, 0xffea, 0x61,
    ]);
  });

  it("types pasted text and drops the Ctrl+V the clipboard bridge sends after it", async () => {
    const { batches, send } = control();
    send({ type: "cut", text: "senha çã" }, ...pasteChord, key(0x61, true));
    await flushed();
    expect(batches).toEqual([
      [
        { t: "text", s: "senha çã" },
        { t: "k", s: 0x61, d: true },
      ],
    ]);
  });

  it("keeps a real Ctrl+V once the paste window has passed", async () => {
    const { batches, send, advance } = control();
    send({ type: "cut", text: "x" });
    advance(2_001);
    send(...pasteChord);
    await flushed();
    expect(batches[0]?.slice(1)).toEqual([
      { t: "k", s: 0xffe3, d: true },
      { t: "k", s: 0x76, d: true },
      { t: "k", s: 0x76, d: false },
      { t: "k", s: 0xffe3, d: false },
    ]);
  });

  it("stops swallowing at the first key that breaks the chord", async () => {
    const { batches, send } = control();
    send({ type: "cut", text: "x" }, key(0x61, true), key(0xffe3, true));
    await flushed();
    expect(batches).toEqual([
      [
        { t: "text", s: "x" },
        { t: "k", s: 0x61, d: true },
        { t: "k", s: 0xffe3, d: true },
      ],
    ]);
  });
});

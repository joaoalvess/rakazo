import { describe, expect, it } from "vitest";
import {
  type ClientEvent,
  compactLength,
  cursorUpdate,
  framebufferUpdate,
  RFB_VERSION,
  RfbProtocolError,
  RfbServer,
  serverInit,
} from "./rfb.js";

function session() {
  const sent: Buffer[] = [];
  const events: ClientEvent[] = [];
  let ready = 0;
  const server = new RfbServer({
    width: 1280,
    height: 800,
    name: "Rakazo screen",
    send: (data) => sent.push(Buffer.from(data)),
    onEvent: (event) => events.push(event),
    onReady: () => {
      ready += 1;
    },
  });
  return { server, sent, events, ready: () => ready };
}

function handshake(server: RfbServer) {
  server.start();
  server.receive(Buffer.from("RFB 003.008\n", "latin1"));
  server.receive(Buffer.from([1]));
  server.receive(Buffer.from([1]));
}

describe("RfbServer", () => {
  it("runs the RFB 3.8 handshake with no authentication", () => {
    const { server, sent, ready } = session();
    handshake(server);
    expect(sent[0]).toEqual(RFB_VERSION);
    expect(sent[1]).toEqual(Buffer.from([1, 1]));
    expect(sent[2]).toEqual(Buffer.alloc(4));
    expect(sent[3]).toEqual(serverInit(1280, 800, "Rakazo screen"));
    expect(server.ready).toBe(true);
    expect(ready()).toBe(1);
  });

  it("parses client messages split across chunks", () => {
    const { server, events } = session();
    handshake(server);
    const encodings = Buffer.alloc(12);
    encodings[0] = 2;
    encodings.writeUInt16BE(2, 2);
    encodings.writeInt32BE(7, 4);
    encodings.writeInt32BE(-239, 8);
    const pointer = Buffer.from([5, 1, 0x01, 0x2c, 0x00, 0xc8]);
    const key = Buffer.from([4, 1, 0, 0, 0, 0, 0xff, 0x0d]);
    const update = Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
    const text = Buffer.from("olá", "latin1");
    const cut = Buffer.concat([Buffer.from([6, 0, 0, 0, 0, 0, 0, text.length]), text]);
    const all = Buffer.concat([encodings, pointer, key, update, cut]);
    for (let offset = 0; offset < all.length; offset += 3) {
      server.receive(all.subarray(offset, offset + 3));
    }
    expect(events).toEqual([
      { type: "encodings", encodings: [7, -239] },
      { type: "pointer", mask: 1, x: 300, y: 200 },
      { type: "key", keysym: 0xff0d, down: true },
      { type: "update", incremental: true },
      { type: "cut", text: "olá" },
    ]);
    expect(server.encodings.has(-239)).toBe(true);
  });

  it("ignores pixel format changes", () => {
    const { server, events } = session();
    handshake(server);
    server.receive(Buffer.alloc(20));
    expect(events).toEqual([]);
  });

  it("rejects unsupported versions and messages", () => {
    const { server } = session();
    server.start();
    expect(() => server.receive(Buffer.from("RFB 003.003\n", "latin1"))).toThrow(RfbProtocolError);
    const other = session();
    handshake(other.server);
    expect(() => other.server.receive(Buffer.from([99]))).toThrow(RfbProtocolError);
  });

  it("rejects oversized clipboard text", () => {
    const { server } = session();
    handshake(server);
    const header = Buffer.from([6, 0, 0, 0, 0, 0, 0, 0]);
    header.writeInt32BE(2 * 1024 * 1024, 4);
    expect(() => server.receive(header)).toThrow(RfbProtocolError);
  });
});

describe("RFB encoding", () => {
  it("writes Tight compact lengths", () => {
    expect(compactLength(0x7f)).toEqual(Buffer.from([0x7f]));
    expect(compactLength(0x80)).toEqual(Buffer.from([0x80, 0x01]));
    expect(compactLength(0x3fff)).toEqual(Buffer.from([0xff, 0x7f]));
    expect(compactLength(0x4000)).toEqual(Buffer.from([0x80, 0x80, 0x01]));
    expect(() => compactLength(0x400000)).toThrow(RangeError);
  });

  it("frames JPEG rects as Tight updates", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const update = framebufferUpdate([{ x: 16, y: 32, width: 64, height: 48, jpeg }]);
    expect(update.readUInt16BE(2)).toBe(1);
    expect(update.readUInt16BE(4)).toBe(16);
    expect(update.readUInt16BE(6)).toBe(32);
    expect(update.readUInt16BE(8)).toBe(64);
    expect(update.readUInt16BE(10)).toBe(48);
    expect(update.readInt32BE(12)).toBe(7);
    expect(update[16]).toBe(0x90);
    expect(update[17]).toBe(4);
    expect(update.subarray(18)).toEqual(jpeg);
  });

  it("sends an arrow cursor with its mask", () => {
    const update = cursorUpdate();
    expect(update.readInt32BE(12)).toBe(-239);
    const width = update.readUInt16BE(8);
    const height = update.readUInt16BE(10);
    expect(update.length).toBe(16 + width * height * 4 + Math.ceil(width / 8) * height);
  });
});

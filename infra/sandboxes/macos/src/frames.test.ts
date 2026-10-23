import { describe, expect, it } from "vitest";
import { type FrameHeader, FrameReader } from "./frames.js";

function encodeFrame(header: FrameHeader, payload: Buffer) {
  const json = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([length, json, payload]);
}

describe("FrameReader", () => {
  it("splits length-prefixed frames into their JPEG rects across chunks", () => {
    const first = encodeFrame(
      {
        seq: 1,
        width: 1280,
        height: 800,
        full: false,
        rects: [
          { x: 0, y: 0, width: 16, height: 16, size: 2 },
          { x: 32, y: 0, width: 16, height: 16, size: 3 },
        ],
      },
      Buffer.from([1, 2, 3, 4, 5]),
    );
    const second = encodeFrame(
      {
        seq: 2,
        width: 1280,
        height: 800,
        full: true,
        rects: [{ x: 0, y: 0, width: 1280, height: 800, size: 1 }],
      },
      Buffer.from([9]),
    );
    const reader = new FrameReader();
    const all = Buffer.concat([first, second]);
    const frames = [];
    for (let offset = 0; offset < all.length; offset += 7) {
      frames.push(...reader.push(all.subarray(offset, offset + 7)));
    }
    expect(frames).toHaveLength(2);
    expect(frames[0]?.rects.map((rect) => [...rect.jpeg])).toEqual([
      [1, 2],
      [3, 4, 5],
    ]);
    expect(frames[1]?.header.full).toBe(true);
    expect([...(frames[1]?.rects[0]?.jpeg ?? [])]).toEqual([9]);
  });

  it("rejects malformed headers", () => {
    const reader = new FrameReader();
    const json = Buffer.from('{"seq":1,"width":"x","height":800,"full":true,"rects":[]}');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(json.length);
    expect(() => reader.push(Buffer.concat([length, json]))).toThrow("malformed frame header");
  });

  it("rejects oversized headers", () => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(1024 * 1024);
    expect(() => new FrameReader().push(length)).toThrow("frame header is too large");
  });
});

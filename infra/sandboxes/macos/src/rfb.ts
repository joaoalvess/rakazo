export const RFB_VERSION = Buffer.from("RFB 003.008\n", "latin1");
export const TIGHT_ENCODING = 7;
export const CURSOR_ENCODING = -239;
const TIGHT_JPEG = 0x90;
const MAX_CUT_TEXT_BYTES = 1024 * 1024;
const MAX_ENCODINGS = 64;

export type ClientEvent =
  | { type: "pointer"; x: number; y: number; mask: number }
  | { type: "key"; keysym: number; down: boolean }
  | { type: "cut"; text: string }
  | { type: "encodings"; encodings: number[] }
  | { type: "update"; incremental: boolean };

export interface JpegRect {
  x: number;
  y: number;
  width: number;
  height: number;
  jpeg: Buffer;
}

export interface RfbServerOptions {
  width: number;
  height: number;
  name: string;
  send(data: Buffer): void;
  onEvent(event: ClientEvent): void;
  onReady(): void;
}

export class RfbProtocolError extends Error {}

export class RfbServer {
  private state: "version" | "security" | "init" | "normal" = "version";
  private buffer: Buffer = Buffer.alloc(0);
  readonly encodings = new Set<number>();

  constructor(private readonly options: RfbServerOptions) {}

  get ready() {
    return this.state === "normal";
  }

  start() {
    this.options.send(RFB_VERSION);
  }

  receive(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.step()) {}
  }

  private step(): boolean {
    if (this.state === "version") {
      if (this.buffer.length < 12) return false;
      const version = this.take(12).toString("latin1");
      if (!/^RFB 003\.00[78]\n$/.test(version))
        throw new RfbProtocolError("unsupported RFB version");
      this.options.send(Buffer.from([1, 1]));
      this.state = "security";
      return true;
    }
    if (this.state === "security") {
      if (this.buffer.length < 1) return false;
      if (this.take(1)[0] !== 1) throw new RfbProtocolError("unsupported security type");
      this.options.send(Buffer.alloc(4));
      this.state = "init";
      return true;
    }
    if (this.state === "init") {
      if (this.buffer.length < 1) return false;
      this.take(1);
      this.options.send(serverInit(this.options.width, this.options.height, this.options.name));
      this.state = "normal";
      this.options.onReady();
      return true;
    }
    return this.message();
  }

  private message(): boolean {
    const type = this.buffer[0];
    if (type === undefined) return false;
    if (type === 0) {
      if (this.buffer.length < 20) return false;
      this.take(20);
      return true;
    }
    if (type === 2) {
      if (this.buffer.length < 4) return false;
      const count = this.buffer.readUInt16BE(2);
      if (count > MAX_ENCODINGS) throw new RfbProtocolError("too many encodings");
      if (this.buffer.length < 4 + count * 4) return false;
      const message = this.take(4 + count * 4);
      const encodings = Array.from({ length: count }, (_, index) =>
        message.readInt32BE(4 + index * 4),
      );
      this.encodings.clear();
      for (const encoding of encodings) this.encodings.add(encoding);
      this.options.onEvent({ type: "encodings", encodings });
      return true;
    }
    if (type === 3) {
      if (this.buffer.length < 10) return false;
      const message = this.take(10);
      this.options.onEvent({ type: "update", incremental: message[1] !== 0 });
      return true;
    }
    if (type === 4) {
      if (this.buffer.length < 8) return false;
      const message = this.take(8);
      this.options.onEvent({
        type: "key",
        keysym: message.readUInt32BE(4),
        down: message[1] !== 0,
      });
      return true;
    }
    if (type === 5) {
      if (this.buffer.length < 6) return false;
      const message = this.take(6);
      this.options.onEvent({
        type: "pointer",
        mask: message[1] ?? 0,
        x: message.readUInt16BE(2),
        y: message.readUInt16BE(4),
      });
      return true;
    }
    if (type === 6) {
      if (this.buffer.length < 8) return false;
      const length = Math.abs(this.buffer.readInt32BE(4));
      if (length > MAX_CUT_TEXT_BYTES) throw new RfbProtocolError("clipboard text is too large");
      if (this.buffer.length < 8 + length) return false;
      const message = this.take(8 + length);
      if (message.readInt32BE(4) >= 0) {
        this.options.onEvent({ type: "cut", text: message.subarray(8).toString("latin1") });
      }
      return true;
    }
    throw new RfbProtocolError(`unsupported client message ${type}`);
  }

  private take(length: number) {
    const bytes = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return bytes;
  }
}

export function serverInit(width: number, height: number, name: string) {
  const nameBytes = Buffer.from(name, "utf8");
  const init = Buffer.alloc(24);
  init.writeUInt16BE(width, 0);
  init.writeUInt16BE(height, 2);
  Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4);
  init.writeUInt32BE(nameBytes.length, 20);
  return Buffer.concat([init, nameBytes]);
}

export function compactLength(length: number) {
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x4000) return Buffer.from([(length & 0x7f) | 0x80, length >> 7]);
  if (length < 0x400000) {
    return Buffer.from([(length & 0x7f) | 0x80, ((length >> 7) & 0x7f) | 0x80, length >> 14]);
  }
  throw new RangeError("Tight data is too large");
}

function rectHeader(x: number, y: number, width: number, height: number, encoding: number) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(x, 0);
  header.writeUInt16BE(y, 2);
  header.writeUInt16BE(width, 4);
  header.writeUInt16BE(height, 6);
  header.writeInt32BE(encoding, 8);
  return header;
}

function updateHeader(count: number) {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(count, 2);
  return header;
}

export function framebufferUpdate(rects: JpegRect[]) {
  const parts: Buffer[] = [updateHeader(rects.length)];
  for (const rect of rects) {
    parts.push(
      rectHeader(rect.x, rect.y, rect.width, rect.height, TIGHT_ENCODING),
      Buffer.from([TIGHT_JPEG]),
      compactLength(rect.jpeg.length),
      rect.jpeg,
    );
  }
  return Buffer.concat(parts);
}

const ARROW = [
  "X           ",
  "XX          ",
  "X.X         ",
  "X..X        ",
  "X...X       ",
  "X....X      ",
  "X.....X     ",
  "X......X    ",
  "X.......X   ",
  "X........X  ",
  "X.........X ",
  "X......XXXXX",
  "X...X..X    ",
  "X..XX..X    ",
  "X.X  X..X   ",
  "XX   X..X   ",
  "X     X..X  ",
  "      X..X  ",
  "       XX   ",
];

export function cursorUpdate() {
  const width = ARROW[0]!.length;
  const height = ARROW.length;
  const rowBytes = Math.ceil(width / 8);
  const pixels = Buffer.alloc(width * height * 4);
  const mask = Buffer.alloc(rowBytes * height);
  ARROW.forEach((row, y) => {
    [...row].forEach((cell, x) => {
      if (cell === " ") return;
      const offset = (y * width + x) * 4;
      pixels.fill(cell === "." ? 255 : 0, offset, offset + 3);
      const bit = y * rowBytes + (x >> 3);
      mask[bit] = (mask[bit] ?? 0) | (0x80 >> (x & 7));
    });
  });
  return Buffer.concat([
    updateHeader(1),
    rectHeader(0, 0, width, height, CURSOR_ENCODING),
    pixels,
    mask,
  ]);
}

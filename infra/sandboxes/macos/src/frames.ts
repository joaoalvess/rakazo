export const MAX_FRAME_HEADER_BYTES = 64 * 1024;

export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
  size: number;
}

export interface FrameHeader {
  seq: number;
  width: number;
  height: number;
  full: boolean;
  rects: FrameRect[];
}

export interface Frame {
  header: FrameHeader;
  rects: Array<FrameRect & { jpeg: Buffer }>;
}

export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames: Frame[] = [];
    while (this.buffer.length >= 4) {
      const headerLength = this.buffer.readUInt32BE(0);
      if (headerLength > MAX_FRAME_HEADER_BYTES) throw new Error("frame header is too large");
      if (this.buffer.length < 4 + headerLength) break;
      const header = parseHeader(this.buffer.subarray(4, 4 + headerLength));
      const start = 4 + headerLength;
      const end = start + header.rects.reduce((total, rect) => total + rect.size, 0);
      if (this.buffer.length < end) break;
      let offset = start;
      const rects = header.rects.map((rect) => {
        const jpeg = Buffer.from(this.buffer.subarray(offset, offset + rect.size));
        offset += rect.size;
        return { ...rect, jpeg };
      });
      frames.push({ header, rects });
      this.buffer = this.buffer.subarray(end);
    }
    return frames;
  }
}

function parseHeader(bytes: Buffer): FrameHeader {
  const header = JSON.parse(bytes.toString("utf8")) as FrameHeader;
  if (
    !Number.isInteger(header.width) ||
    !Number.isInteger(header.height) ||
    !Array.isArray(header.rects) ||
    header.rects.some((rect) => !Number.isInteger(rect.size) || rect.size < 0)
  ) {
    throw new Error("malformed frame header");
  }
  return header;
}

import net from "node:net";
import path from "node:path";
import { type Frame, FrameReader } from "./frames.js";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenInfo {
  slot: number;
  displayID: number;
  bounds: Rect;
  awake: boolean;
  displayAsleep: boolean;
  adopted: boolean;
  viewers: number;
}

export type InputEvent =
  | { t: "p"; x: number; y: number; m: number }
  | { t: "k"; s: number; d: boolean }
  | { t: "text"; s: string };

export interface DisplaydRequest {
  op:
    | "status"
    | "permissions"
    | "open"
    | "close"
    | "wake"
    | "sleep"
    | "screenshot"
    | "overlay"
    | "input"
    | "takeover";
  slot?: number;
  cursor?: { x: number; y: number };
  click?: { x: number; y: number };
  typing?: boolean;
  cursorHidden?: boolean;
  events?: InputEvent[];
  active?: boolean;
  overlays?: boolean;
  format?: "png" | "jpeg";
  quality?: number;
  prompt?: boolean;
}

export interface DisplaydResponse {
  ok: boolean;
  error?: string;
  screens?: ScreenInfo[];
  screen?: ScreenInfo;
  permissions?: { screenCapture: boolean; postEvents: boolean; accessibility: boolean };
  image?: string;
  mimeType?: "image/png" | "image/jpeg";
}

export interface FrameSubscription {
  requestFull(): void;
  close(): void;
}

interface Pending {
  resolve(response: DisplaydResponse): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

const MAX_RESPONSE_LINE_BYTES = 32 * 1024 * 1024;

export class DisplaydClient {
  private socket?: Promise<net.Socket>;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(readonly directory: string) {}

  async call(request: DisplaydRequest, timeoutMs = 15_000): Promise<DisplaydResponse> {
    const socket = await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`displayd ${request.op} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (response) =>
          response.ok
            ? resolve(response)
            : reject(new Error(response.error ?? `displayd ${request.op} failed`)),
        reject,
        timer,
      });
      socket.write(`${JSON.stringify({ ...request, id })}\n`);
    });
  }

  frames(
    slot: number,
    options: { fps: number; quality: number },
    handlers: { onFrame(frame: Frame): void; onClose(error?: Error): void },
  ): FrameSubscription {
    const socket = net.createConnection(path.join(this.directory, "frames.sock"));
    const reader = new FrameReader();
    let closed = false;
    const finish = (error?: Error) => {
      if (closed) return;
      closed = true;
      socket.destroy();
      handlers.onClose(error);
    };
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ slot, fps: options.fps, quality: options.quality })}\n`);
    });
    socket.on("data", (chunk) => {
      try {
        for (const frame of reader.push(chunk)) handlers.onFrame(frame);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish());
    return {
      requestFull: () => {
        if (!closed && socket.writable) socket.write('{"full":true}\n');
      },
      close: () => {
        closed = true;
        socket.destroy();
      },
    };
  }

  private connect(): Promise<net.Socket> {
    if (this.socket) return this.socket;
    const connecting = new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection(path.join(this.directory, "control.sock"));
      let lines = "";
      socket.setEncoding("utf8");
      socket.once("connect", () => resolve(socket));
      socket.on("data", (chunk: string) => {
        lines += chunk;
        if (lines.length > MAX_RESPONSE_LINE_BYTES) {
          socket.destroy(new Error("displayd response is too large"));
          return;
        }
        let newline = lines.indexOf("\n");
        while (newline !== -1) {
          this.settle(lines.slice(0, newline));
          lines = lines.slice(newline + 1);
          newline = lines.indexOf("\n");
        }
      });
      socket.on("error", (error) => {
        reject(error);
        this.drop(error);
      });
      socket.on("close", () => this.drop(new Error("displayd closed the connection")));
    });
    this.socket = connecting;
    return connecting;
  }

  private settle(line: string) {
    let response: DisplaydResponse & { id?: number };
    try {
      response = JSON.parse(line);
    } catch {
      return;
    }
    if (response.id === undefined) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  private drop(error: Error) {
    this.socket = undefined;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

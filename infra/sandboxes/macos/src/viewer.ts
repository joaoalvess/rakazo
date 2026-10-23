import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import type { FeedViewer, ScreenFeeds } from "./feed.js";
import type { Frame } from "./frames.js";
import {
  type ClientEvent,
  CURSOR_ENCODING,
  cursorUpdate,
  framebufferUpdate,
  RfbServer,
} from "./rfb.js";

export interface ViewerGrant {
  screenKey: string;
  slot: number;
  control: boolean;
  width: number;
  height: number;
}

export interface ViewerOptions {
  embedRoot: string;
  novncRoot: string;
  feeds: ScreenFeeds;
  authorize(token: string): ViewerGrant | undefined;
  controlInput?(grant: ViewerGrant): (event: ClientEvent) => void;
}

const EMBED_FILES = new Set(["/embed.html", "/clipboard-bridge.js", "/mobile-keyboard.js"]);
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export function createViewerServer(options: ViewerOptions) {
  const sockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 2 * 1024 * 1024,
  });
  const sessions = new Set<ViewerSession>();
  const server = http.createServer((request, response) => {
    void serveStatic(options, request, response);
  });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://viewer");
    const token = url.searchParams.get("token") ?? "";
    const grant = url.pathname === "/websockify" && token ? options.authorize(token) : undefined;
    if (!grant) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const session = new ViewerSession(ws, grant, options);
      sessions.add(session);
      ws.once("close", () => sessions.delete(session));
    });
  });
  return {
    server,
    revoke(matches: (grant: ViewerGrant) => boolean) {
      for (const session of sessions) if (matches(session.grant)) session.close();
    },
    close() {
      for (const session of sessions) session.terminate();
      sockets.close();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function serveStatic(
  options: ViewerOptions,
  request: http.IncomingMessage,
  response: http.ServerResponse,
) {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://viewer").pathname);
    const root = EMBED_FILES.has(pathname)
      ? options.embedRoot
      : /^\/(core|vendor)\//.test(pathname)
        ? options.novncRoot
        : undefined;
    if (request.method !== "GET" || !root) throw new Error("not found");
    const base = path.resolve(root);
    const file = path.resolve(base, `.${pathname}`);
    if (!file.startsWith(`${base}${path.sep}`)) throw new Error("not found");
    const body = await readFile(file);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  }
}

class ViewerSession implements FeedViewer {
  private readonly rfb: RfbServer;
  private readonly input?: (event: ClientEvent) => void;
  private detach?: () => void;
  private needsFull = true;
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    readonly grant: ViewerGrant,
    private readonly options: ViewerOptions,
  ) {
    this.input = grant.control ? options.controlInput?.(grant) : undefined;
    this.rfb = new RfbServer({
      width: grant.width,
      height: grant.height,
      name: "Rakazo screen",
      send: (data) => this.send(data),
      onEvent: (event) => this.onEvent(event),
      onReady: () => {
        this.detach = options.feeds.attach(grant.slot, this);
      },
    });
    ws.on("message", (data) => {
      try {
        this.rfb.receive(toBuffer(data));
      } catch {
        this.close();
      }
    });
    ws.on("close", () => {
      this.closed = true;
      this.detach?.();
    });
    ws.on("error", () => this.close());
    this.rfb.start();
  }

  frame(frame: Frame) {
    if (this.closed) return;
    if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.needsFull = true;
      return;
    }
    if (this.needsFull && !frame.header.full) {
      if (this.ws.bufferedAmount < MAX_BUFFERED_BYTES / 4) {
        this.options.feeds.requestFull(this.grant.slot);
      }
      return;
    }
    this.needsFull = false;
    this.send(framebufferUpdate(frame.rects));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.ws.close();
    this.detach?.();
  }

  terminate() {
    this.closed = true;
    this.ws.terminate();
    this.detach?.();
  }

  private onEvent(event: ClientEvent) {
    if (event.type === "encodings") {
      if (event.encodings.includes(CURSOR_ENCODING)) this.send(cursorUpdate());
      return;
    }
    if (event.type === "update") {
      if (!event.incremental && !this.needsFull) {
        this.needsFull = true;
        this.options.feeds.requestFull(this.grant.slot);
      }
      return;
    }
    this.input?.(event);
  }

  private send(data: Buffer) {
    if (!this.closed && this.ws.readyState === this.ws.OPEN) this.ws.send(data);
  }
}

function toBuffer(data: RawData) {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

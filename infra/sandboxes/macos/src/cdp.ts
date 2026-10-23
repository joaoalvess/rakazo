import WebSocket from "ws";

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  readonly closed: Promise<void>;

  static open(url: string, timeoutMs = 5_000) {
    return new Promise<CdpConnection>((resolve, reject) => {
      const socket = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: timeoutMs });
      socket.once("open", () => resolve(new CdpConnection(socket)));
      socket.once("error", reject);
    });
  }

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => this.receive(String(data)));
    this.closed = new Promise((resolve) => {
      socket.once("close", () => {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Chrome closed the DevTools connection"));
        }
        this.pending.clear();
        resolve();
      });
    });
    socket.on("error", () => socket.terminate());
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: object = {},
    sessionId?: string,
    timeoutMs = 5_000,
  ) {
    return new Promise<T>((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error("Chrome DevTools connection is closed"));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (result) => resolve(result as T), reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(listener: (event: CdpEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.socket.close();
  }

  private receive(raw: string) {
    let message: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? "CDP request failed"));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (!message.method) return;
    const event = {
      method: message.method,
      params: message.params ?? {},
      ...(message.sessionId ? { sessionId: message.sessionId } : {}),
    };
    for (const listener of this.listeners) listener(event);
  }
}

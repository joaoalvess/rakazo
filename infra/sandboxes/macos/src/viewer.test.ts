import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ScreenFeeds } from "./feed.js";
import type { Frame } from "./frames.js";
import type { ClientEvent } from "./rfb.js";
import { createViewerServer, type ViewerGrant } from "./viewer.js";

let directory: string;
let viewer: ReturnType<typeof createViewerServer>;
let baseUrl: string;
let pushFrame: ((frame: Frame) => void) | undefined;
let fullRequests = 0;
let closedSubscriptions = 0;
let closedControls = 0;
const inputs: Array<{ grant: ViewerGrant; event: ClientEvent }> = [];

const grants: Record<string, ViewerGrant> = {
  view: { screenKey: "bot-a", slot: 0, control: false, width: 1280, height: 800 },
  control: { screenKey: "bot-a", slot: 0, control: true, width: 1280, height: 800 },
};

function frame(full: boolean, bytes: number[]): Frame {
  const jpeg = Buffer.from(bytes);
  const rect = full
    ? { x: 0, y: 0, width: 1280, height: 800, size: jpeg.length }
    : { x: 16, y: 16, width: 16, height: 16, size: jpeg.length };
  return {
    header: { seq: 1, width: 1280, height: 800, full, rects: [rect] },
    rects: [{ ...rect, jpeg }],
  };
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "macos-viewer-"));
  const embedRoot = path.join(directory, "computer");
  const novncRoot = path.join(directory, "novnc");
  await mkdir(path.join(novncRoot, "core"), { recursive: true });
  await mkdir(embedRoot, { recursive: true });
  await writeFile(path.join(embedRoot, "embed.html"), "<html></html>");
  await writeFile(path.join(directory, "secret.txt"), "secret");
  await writeFile(path.join(novncRoot, "core", "rfb.js"), "export default {};");
  fullRequests = 0;
  closedSubscriptions = 0;
  closedControls = 0;
  inputs.length = 0;
  const feeds = new ScreenFeeds(
    {
      frames: (_slot, _options, handlers) => {
        pushFrame = handlers.onFrame;
        return {
          requestFull: () => {
            fullRequests += 1;
          },
          close: () => {
            closedSubscriptions += 1;
          },
        };
      },
    },
    { fps: 30, quality: 0.6 },
  );
  viewer = createViewerServer({
    embedRoot,
    novncRoot,
    feeds,
    authorize: (token) => grants[token],
    controlInput: (grant) => ({
      handle: (event) => inputs.push({ grant, event }),
      close: () => {
        closedControls += 1;
      },
    }),
  });
  await new Promise<void>((resolve) => viewer.server.listen(0, "127.0.0.1", resolve));
  baseUrl = `127.0.0.1:${(viewer.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await viewer.close();
  await rm(directory, { recursive: true, force: true });
});

class Client {
  private readonly messages: Buffer[] = [];
  private waiting?: () => void;
  readonly socket: WebSocket;
  readonly closed: Promise<void>;

  constructor(token: string) {
    this.socket = new WebSocket(`ws://${baseUrl}/websockify?token=${token}`, ["binary"]);
    this.socket.on("message", (data: Buffer) => {
      this.messages.push(Buffer.from(data));
      this.waiting?.();
    });
    this.closed = new Promise((resolve) => this.socket.once("close", () => resolve()));
  }

  async next(): Promise<Buffer> {
    while (!this.messages.length) {
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
    return this.messages.shift()!;
  }

  async connect() {
    await new Promise((resolve) => this.socket.once("open", resolve));
    expect((await this.next()).toString("latin1")).toBe("RFB 003.008\n");
    this.socket.send(Buffer.from("RFB 003.008\n", "latin1"));
    expect(await this.next()).toEqual(Buffer.from([1, 1]));
    this.socket.send(Buffer.from([1]));
    expect(await this.next()).toEqual(Buffer.alloc(4));
    this.socket.send(Buffer.from([1]));
    const init = await this.next();
    expect(init.readUInt16BE(0)).toBe(1280);
    expect(init.readUInt16BE(2)).toBe(800);
  }
}

describe("viewer", () => {
  it("serves embed.html and noVNC but nothing outside them", async () => {
    expect((await fetch(`http://${baseUrl}/embed.html`)).status).toBe(200);
    expect((await fetch(`http://${baseUrl}/core/rfb.js`)).headers.get("content-type")).toContain(
      "javascript",
    );
    expect((await fetch(`http://${baseUrl}/core/../../secret.txt`)).status).toBe(404);
    expect((await fetch(`http://${baseUrl}/core/%2e%2e/%2e%2e/secret.txt`)).status).toBe(404);
    expect((await fetch(`http://${baseUrl}/secret.txt`)).status).toBe(404);
  });

  it("refuses a WebSocket without a known token", async () => {
    const socket = new WebSocket(`ws://${baseUrl}/websockify?token=nope`);
    const status = await new Promise<number | undefined>((resolve) => {
      socket.on("unexpected-response", (_request, response) => resolve(response.statusCode));
      socket.on("error", () => resolve(undefined));
    });
    expect(status).toBe(403);
  });

  it("streams a full frame first and then dirty rects", async () => {
    const client = new Client("view");
    await client.connect();
    const encodings = Buffer.alloc(8);
    encodings[0] = 2;
    encodings.writeUInt16BE(1, 2);
    encodings.writeInt32BE(-239, 4);
    client.socket.send(encodings);
    expect((await client.next()).readInt32BE(12)).toBe(-239);
    pushFrame?.(frame(false, [1]));
    expect(fullRequests).toBe(1);
    pushFrame?.(frame(true, [2, 2]));
    const full = await client.next();
    expect(full.readUInt16BE(8)).toBe(1280);
    expect([...full.subarray(18)]).toEqual([2, 2]);
    pushFrame?.(frame(false, [3]));
    const dirty = await client.next();
    expect(dirty.readUInt16BE(4)).toBe(16);
    expect([...dirty.subarray(18)]).toEqual([3]);
    client.socket.close();
    await client.closed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closedSubscriptions).toBe(1);
  });

  it("forwards input only from a control session", async () => {
    const view = new Client("view");
    await view.connect();
    view.socket.send(Buffer.from([5, 1, 0, 10, 0, 20]));
    const control = new Client("control");
    await control.connect();
    control.socket.send(Buffer.from([5, 1, 0, 10, 0, 20]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(inputs).toEqual([
      { grant: grants.control, event: { type: "pointer", mask: 1, x: 10, y: 20 } },
    ]);
  });

  it("closes the sessions a revocation matches", async () => {
    const view = new Client("view");
    await view.connect();
    const control = new Client("control");
    await control.connect();
    viewer.revoke((grant) => grant.control);
    await control.closed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closedControls).toBe(1);
    expect(view.socket.readyState).toBe(WebSocket.OPEN);
    view.socket.close();
    await view.closed;
  });
});

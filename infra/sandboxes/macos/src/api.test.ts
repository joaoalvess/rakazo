import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi, type ScreenService } from "./api.js";
import { type ScreenRecord, ScreenRegistry } from "./screens.js";

const token = "t".repeat(32);
let directory: string;
let registry: ScreenRegistry;
let opened: string[];
let revoked: ScreenRecord[];
let app: ReturnType<typeof createApi>;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "macos-api-"));
  registry = new ScreenRegistry(path.join(directory, "state.json"), 2);
  opened = [];
  revoked = [];
  const service: ScreenService = {
    registry,
    viewerUrl: "http://127.0.0.1:7093/embed.html",
    async openScreen(key) {
      opened.push(key);
      return (await registry.allocate(key)).record;
    },
    async revokeControl(record) {
      revoked.push({ ...record });
      registry.setControl(record.key, undefined);
    },
  };
  app = createApi(service, token);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function request(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "bot-a",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function tokenOf(screenUrl: string) {
  return new URLSearchParams(new URL(screenUrl).searchParams.get("path")!.split("?")[1]).get(
    "token",
  );
}

describe("macOS screens API", () => {
  it("requires the supervisor token", async () => {
    const response = await app.request("/computers/c1", { headers: { authorization: "Bearer x" } });
    expect(response.status).toBe(401);
  });

  it("reports the computer as running", async () => {
    expect(await (await request("GET", "/computers/c1")).json()).toEqual({
      id: "c1",
      running: true,
    });
  });

  it("opens a screen for a takeover and hands out the control URL", async () => {
    const response = await request("POST", "/computers/c1/screen-mode", {
      interactive: true,
      controlToken: "control-1",
    });
    const body = (await response.json()) as { screenUrl: string };
    expect(opened).toEqual(["bot-a"]);
    expect(tokenOf(body.screenUrl)).toBe("control-1");
    expect(body.screenUrl.startsWith("http://127.0.0.1:7093/embed.html?")).toBe(true);
    expect(registry.byToken("control-1")?.control).toBe(true);
  });

  it("never allocates a screen for a view", async () => {
    const response = await request("POST", "/computers/c1/screen-mode", {
      interactive: false,
      revokeControl: false,
    });
    expect(response.status).toBe(404);
    expect(opened).toEqual([]);
    expect((await request("GET", "/computers/c1/screen")).status).toBe(404);
  });

  it("hands out the view URL of an open screen", async () => {
    const { record } = await registry.allocate("bot-a");
    const response = await request("POST", "/computers/c1/screen-mode", {
      interactive: false,
      revokeControl: false,
    });
    const body = (await response.json()) as { screenUrl: string };
    expect(tokenOf(body.screenUrl)).toBe(record.viewToken);
    const redirect = await request("GET", "/computers/c1/screen");
    expect(redirect.status).toBe(302);
    expect(tokenOf(redirect.headers.get("location")!)).toBe(record.viewToken);
  });

  it("revokes control on a non-interactive request and on release", async () => {
    await request("POST", "/computers/c1/screen-mode", {
      interactive: true,
      controlToken: "control-1",
    });
    await request("POST", "/computers/c1/screen-mode", { interactive: false });
    expect(revoked.map((record) => record.controlToken)).toEqual(["control-1"]);
    await request("POST", "/computers/c1/screen-mode", {
      interactive: true,
      controlToken: "control-2",
    });
    expect((await request("DELETE", "/computers/c1/screen")).status).toBe(200);
    expect(revoked.map((record) => record.controlToken)).toEqual(["control-1", "control-2"]);
    expect(registry.get("bot-a")).toBeDefined();
  });

  it("revokes the old control token when control is granted again", async () => {
    for (const controlToken of ["control-1", "control-1", "control-2"]) {
      await request("POST", "/computers/c1/screen-mode", { interactive: true, controlToken });
    }
    expect(revoked.map((record) => record.controlToken)).toEqual(["control-1"]);
    expect(registry.byToken("control-1")).toBeUndefined();
    expect(registry.byToken("control-2")?.control).toBe(true);
  });

  it("keys screens by the screen id before the bot id", async () => {
    await request(
      "POST",
      "/computers/c1/screen-mode",
      { interactive: true, controlToken: "control-1" },
      { "x-rakazo-screen-id": "screen-9" },
    );
    expect(opened).toEqual(["screen-9"]);
  });

  it("rejects an interactive request without a control token", async () => {
    const response = await request("POST", "/computers/c1/screen-mode", { interactive: true });
    expect(response.status).toBe(400);
  });
});

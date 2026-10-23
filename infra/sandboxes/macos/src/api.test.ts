import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ComputerAction } from "./actions.js";
import { createApi, type ScreenService } from "./api.js";
import type { PageBrowserCommand } from "./page-browser.js";
import { type ScreenRecord, ScreenRegistry } from "./screens.js";

const token = "t".repeat(32);
let directory: string;
let registry: ScreenRegistry;
let opened: string[];
let revoked: ScreenRecord[];
let acted: Array<[string, ComputerAction[]]>;
let browsed: Array<[string, PageBrowserCommand]>;
let woken: string[];
let failure: Error | undefined;
let app: ReturnType<typeof createApi>;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "macos-api-"));
  registry = new ScreenRegistry(path.join(directory, "state.json"), 2);
  opened = [];
  revoked = [];
  acted = [];
  browsed = [];
  woken = [];
  failure = undefined;
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
    async observe(key) {
      return {
        image: Buffer.from(key).toString("base64"),
        mimeType: "image/png",
        width: 1280,
        height: 800,
        cursor: { x: 1, y: 2 },
      };
    },
    async act(key, actions) {
      if (failure) throw failure;
      acted.push([key, actions]);
      return actions.length;
    },
    async browser(key, command) {
      if (failure) throw failure;
      browsed.push([key, command]);
      return { ok: true, url: "https://example.com/" };
    },
    async wake(key) {
      if (failure) throw failure;
      woken.push(key);
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

  it("observes the bot's screen", async () => {
    const response = await request("POST", "/computers/c1/observe");
    expect(await response.json()).toEqual({
      image: Buffer.from("bot-a").toString("base64"),
      mimeType: "image/png",
      width: 1280,
      height: 800,
      cursor: { x: 1, y: 2 },
    });
  });

  it("acts on the bot's screen and answers like the Docker supervisor", async () => {
    const actions = [
      { kind: "pointer", x: 10, y: 20, type: "click" },
      { kind: "clipboard", text: "oi" },
    ];
    const observed = await request("POST", "/computers/c1/actions", { actions, settleMs: 1 });
    expect(await observed.json()).toMatchObject({ completed: 2, observation: { width: 1280 } });
    const blind = await request("POST", "/computers/c1/actions", { actions, observe: false });
    expect(await blind.json()).toEqual({ completed: 2 });
    expect(acted).toEqual([
      ["bot-a", actions],
      ["bot-a", actions],
    ]);
    const invalid = await request("POST", "/computers/c1/actions", {
      actions: [{ kind: "teleport" }],
    });
    expect(invalid.status).toBe(400);
    failure = new Error("cua-driver click failed: window_target_not_found");
    const failed = await request("POST", "/computers/c1/actions", { actions });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      error: "cua-driver click failed: window_target_not_found",
    });
  });

  it("runs page browser commands on the bot's screen", async () => {
    const response = await request("POST", "/computers/c1/browser", { command: "snapshot" });
    expect(await response.json()).toEqual({ ok: true, url: "https://example.com/" });
    const fill = {
      command: "act",
      actions: [{ kind: "fill", ref: "e1", text: "x", origin: "https://login.example.com" }],
    };
    await request("POST", "/computers/c1/browser", fill);
    expect(browsed).toEqual([
      ["bot-a", { command: "snapshot" }],
      ["bot-a", fill],
    ]);
    for (const invalid of [
      { command: "navigate", url: "file:///etc/hosts" },
      { command: "navigate", url: "https://user:secret@example.com" },
      { command: "act", actions: [] },
    ]) {
      expect((await request("POST", "/computers/c1/browser", invalid)).status).toBe(400);
    }
  });

  it("answers page browser failures with the computer_act fallback", async () => {
    failure = new Error("Page browser unavailable or interrupted");
    const act = await request("POST", "/computers/c1/browser", {
      command: "act",
      actions: [{ kind: "click", ref: "e1" }],
    });
    expect(await act.json()).toEqual({
      ok: false,
      fallback: "computer_act",
      uncertain: true,
      error: "Page browser unavailable or interrupted. Inspect the screen before continuing.",
    });
    failure = new Error("the bot's browser window is not available");
    const snapshot = await request("POST", "/computers/c1/browser", { command: "snapshot" });
    expect(await snapshot.json()).toEqual({
      ok: false,
      fallback: "computer_act",
      uncertain: false,
      error: "the bot's browser window is not available",
    });
  });

  it("wakes an allocated screen and refuses one that is not", async () => {
    const missing = await request("POST", "/computers/c1/screen/wake");
    expect(missing.status).toBe(404);
    await registry.allocate("bot-a");
    const response = await request("POST", "/computers/c1/screen/wake");
    expect(await response.json()).toEqual({ ok: true });
    expect(woken).toEqual(["bot-a"]);
    failure = new Error("screen 0 is not open");
    const failed = await request("POST", "/computers/c1/screen/wake");
    expect(failed.status).toBe(500);
  });

  it("turns leased input into one action", async () => {
    const response = await request("POST", "/computers/c1/input", {
      input: { kind: "pointer", x: 5, y: 6 },
      leaseId: "lease-1",
    });
    expect(await response.json()).toEqual({ ok: true, leaseId: "lease-1" });
    await request("POST", "/computers/c1/input", { input: { kind: "key", key: "Return" } });
    expect(acted.map(([, actions]) => actions)).toEqual([
      [{ kind: "pointer", x: 5, y: 6, type: "click" }],
      [{ kind: "key", key: "Return" }],
    ]);
  });

  it("rejects an interactive request without a control token", async () => {
    const response = await request("POST", "/computers/c1/screen-mode", { interactive: true });
    expect(response.status).toBe(400);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { MacScreensClient } from "./macos-screens-client.js";

const context = {
  operationId: "mac-screens-test",
  traceId: "mac-screens-test",
  spaceId: "workspace",
  userId: "user",
  botId: "bot-a",
  signal: new AbortController().signal,
};

const observation = {
  image: Buffer.from("png").toString("base64"),
  mimeType: "image/png",
  width: 1280,
  height: 800,
  cursor: { x: 1, y: 2 },
  activeWindow: { id: "1981", title: "Example Domain" },
};

let root: string;
let calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }>;

function supervisor(answer: (url: string, method: string) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      calls.push({
        url,
        method,
        headers: init.headers as Record<string, string>,
        ...(typeof init.body === "string" ? { body: JSON.parse(init.body) } : {}),
      });
      return answer(url, method);
    }),
  );
}

async function provision(screens = true) {
  const provider = new DesktopSandboxProvider({
    root,
    ...(screens
      ? { screens: new MacScreensClient("http://127.0.0.1:7092/", "supervisor-token") }
      : {}),
  });
  const computer = await provider.provision({ botId: "bot-a", homePath: "" }, context);
  return { provider, computer, home: path.join(root, "desktop-computers", "bot-a") };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mac-screens-provider-"));
  calls = [];
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe("Desktop sandbox with macOS screens", () => {
  it("declares a graphical computer only when the screens supervisor is configured", async () => {
    const plain = await provision(false);
    expect(plain.provider.describe().capabilities).toMatchObject({
      graphical: false,
      takeover: false,
      multiScreen: false,
    });
    expect(plain.provider.pageBrowser).toBeUndefined();
    expect(plain.provider.setScreenControl).toBeUndefined();
    expect(plain.provider.releaseScreen).toBeUndefined();
    const screens = await provision();
    expect(screens.provider.describe().capabilities).toMatchObject({
      graphical: true,
      takeover: true,
      multiScreen: true,
    });
  });

  it("acts on the bot's screen and opens workspace files from the bot's home", async () => {
    supervisor(() => Response.json({ completed: 3, observation }));
    const { provider, computer, home } = await provision();
    const result = await provider.act(
      computer,
      {
        actions: [
          { kind: "open", path: "relatórios/março.pdf" },
          { kind: "open", path: "https://example.com/" },
          { kind: "pointer", x: 10, y: 20, type: "click" },
        ],
        settleMs: 300,
      },
      context,
    );
    expect(result.completed).toBe(3);
    expect(result.observation?.activeWindow).toEqual({ id: "1981", title: "Example Domain" });
    expect(Buffer.from(result.observation!.image).toString()).toBe("png");
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:7092/computers/desktop-bot-a/actions",
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer supervisor-token",
          "x-rakazo-bot-id": "bot-a",
          "x-rakazo-screen-id": "bot-a",
        }),
        body: {
          actions: [
            { kind: "open", path: path.join(home, "relatórios/março.pdf") },
            { kind: "open", path: "https://example.com/" },
            { kind: "pointer", x: 10, y: 20, type: "click" },
          ],
          settleMs: 300,
        },
      },
    ]);
    await expect(
      provider.act(computer, { actions: [{ kind: "open", path: "../segredo.txt" }] }, context),
    ).rejects.toThrow("Path escapes the computer workspace");
  });

  it("observes and sends leased input through the supervisor", async () => {
    supervisor((url) =>
      url.endsWith("/observe") ? Response.json(observation) : Response.json({ ok: true }),
    );
    const { provider, computer } = await provision();
    const observed = await provider.observe(computer, context);
    expect(observed).toMatchObject({ width: 1280, height: 800, cursor: { x: 1, y: 2 } });
    await provider.sendInput(
      computer,
      { kind: "key", key: "Return" },
      { leaseId: "lease-1" } as never,
      context,
    );
    expect(calls.map(({ url, body }) => [url.split("/").pop(), body])).toEqual([
      ["observe", undefined],
      ["input", { input: { kind: "key", key: "Return" }, leaseId: "lease-1" }],
    ]);
  });

  it("runs the page browser with the bot's home for uploads", async () => {
    supervisor(() => Response.json({ ok: true, url: "https://example.com/" }));
    const { provider, computer, home } = await provision();
    expect(await provider.pageBrowser!(computer, { command: "snapshot" }, context)).toEqual({
      ok: true,
      url: "https://example.com/",
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:7092/computers/desktop-bot-a/browser");
    expect(decodeURIComponent(calls[0]!.headers["x-rakazo-computer-home"]!)).toBe(home);
  });

  it("shows nothing for a screen the bot never used and grants control on request", async () => {
    supervisor((_url, method) =>
      calls.length === 1
        ? Response.json({ error: "screen is not allocated" }, { status: 404 })
        : method === "POST"
          ? Response.json({
              screenUrl: "http://127.0.0.1:7093/embed.html?path=websockify%3Ftoken%3Dc",
            })
          : Response.json({ ok: true }),
    );
    const { provider, computer } = await provision();
    expect((await provider.connectScreen(computer, { view: "stream" }, context)).url).toBeNull();
    const control = await provider.connectScreen(
      computer,
      { view: "stream", interactive: true, controlToken: "c" },
      context,
    );
    expect(control.url).toContain("websockify");
    await provider.setScreenControl!(computer, false, context);
    await provider.releaseScreen!(computer, context);
    expect(calls.map(({ url, method, body }) => [method, url.split("/").pop(), body])).toEqual([
      ["POST", "screen-mode", { interactive: false, revokeControl: false }],
      ["POST", "screen-mode", { interactive: true, controlToken: "c", revokeControl: false }],
      ["POST", "screen-mode", { interactive: false }],
      ["DELETE", "screen", undefined],
    ]);
  });

  it("resets the bot's screen when its computer is recovered or reset", async () => {
    supervisor(() => Response.json({ ok: true }));
    const { provider, computer } = await provision();
    await provider.destroy(computer, context);
    expect(calls).toEqual([
      expect.objectContaining({
        url: "http://127.0.0.1:7092/computers/desktop-bot-a/screen/reset",
        method: "POST",
        headers: expect.objectContaining({ "x-rakazo-screen-id": "bot-a" }),
      }),
    ]);
    const plain = await provision(false);
    await plain.provider.destroy(plain.computer, context);
    expect(calls).toHaveLength(1);
  });

  it("fails a control request the supervisor cannot grant", async () => {
    supervisor(() =>
      Response.json({ error: "This computer cannot allocate another screen." }, { status: 400 }),
    );
    const { provider, computer } = await provision();
    await expect(
      provider.connectScreen(
        computer,
        { view: "stream", interactive: true, controlToken: "c" },
        context,
      ),
    ).rejects.toThrow("This Mac cannot allocate another screen.");
  });
});

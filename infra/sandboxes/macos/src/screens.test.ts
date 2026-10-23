import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveScreenLimit, ScreenRegistry } from "./screens.js";

let directory: string;
let file: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "macos-screens-"));
  file = path.join(directory, "state.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("ScreenRegistry", () => {
  it("gives each screen the lowest free slot and keeps it", async () => {
    const registry = new ScreenRegistry(file, 3);
    expect((await registry.allocate("bot-a", 1)).record.slot).toBe(0);
    expect((await registry.allocate("bot-b", 2)).record.slot).toBe(1);
    expect((await registry.allocate("bot-a", 3)).record.slot).toBe(0);
    expect(registry.get("bot-a")?.lastUsedAt).toBe(3);
  });

  it("saves screens allocated at the same time", async () => {
    const registry = new ScreenRegistry(file, 3);
    await Promise.all(["bot-a", "bot-b", "bot-c"].map((key) => registry.allocate(key)));
    const saved = JSON.parse(await readFile(file, "utf8")) as { screens: Array<{ key: string }> };
    expect(saved.screens.map((screen) => screen.key).sort()).toEqual(["bot-a", "bot-b", "bot-c"]);
  });

  it("evicts the least recently used screen without control at the limit", async () => {
    const registry = new ScreenRegistry(file, 2);
    await registry.allocate("bot-a", 1);
    await registry.allocate("bot-b", 2);
    registry.setControl("bot-a", "control-a");
    const { record, evicted } = await registry.allocate("bot-c", 3);
    expect(evicted?.key).toBe("bot-b");
    expect(record.slot).toBe(1);
    expect(registry.get("bot-b")).toBeUndefined();
  });

  it("refuses a new screen when every screen is under control", async () => {
    const registry = new ScreenRegistry(file, 1);
    await registry.allocate("bot-a", 1);
    registry.setControl("bot-a", "control-a");
    await expect(registry.allocate("bot-b", 2)).rejects.toThrow("cannot allocate another screen");
  });

  it("finds a screen by its view or control token", async () => {
    const registry = new ScreenRegistry(file, 2);
    const { record } = await registry.allocate("bot-a", 1);
    registry.setControl("bot-a", "control-a");
    expect(registry.byToken(record.viewToken)).toEqual({ record, control: false });
    expect(registry.byToken("control-a")).toEqual({ record, control: true });
    expect(registry.byToken("other")).toBeUndefined();
    registry.setControl("bot-a", undefined);
    expect(registry.byToken("control-a")).toBeUndefined();
  });

  it("persists screens, view tokens and browser windows but never control tokens", async () => {
    const registry = new ScreenRegistry(file, 2);
    const { record } = await registry.allocate("bot-a", 1);
    registry.setControl("bot-a", "control-a");
    await registry.setBrowser("bot-a", { browserId: "chrome-1", windowId: 7 });
    await registry.touch("bot-a", 5);
    expect(await readFile(file, "utf8")).not.toContain("control-a");
    const restored = new ScreenRegistry(file, 2);
    await restored.load();
    expect(restored.get("bot-a")).toEqual({
      key: "bot-a",
      slot: 0,
      viewToken: record.viewToken,
      browser: { browserId: "chrome-1", windowId: 7 },
      lastUsedAt: 5,
    });
  });

  it("drops persisted screens beyond a lowered limit", async () => {
    const registry = new ScreenRegistry(file, 3);
    await registry.allocate("bot-a", 1);
    await registry.allocate("bot-b", 2);
    const restored = new ScreenRegistry(file, 1);
    await restored.load();
    expect(restored.list().map((record) => record.key)).toEqual(["bot-a"]);
  });
});

describe("resolveScreenLimit", () => {
  it("defaults to nine screens and validates the range", () => {
    expect(resolveScreenLimit(undefined)).toBe(9);
    expect(resolveScreenLimit("4")).toBe(4);
    expect(() => resolveScreenLimit("0")).toThrow();
    expect(() => resolveScreenLimit("17")).toThrow();
    expect(() => resolveScreenLimit("two")).toThrow();
  });
});

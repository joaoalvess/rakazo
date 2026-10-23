import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { BrowserWindow } from "./chrome.js";

export const SLOT_COUNT = 16;
export const SCREEN_WIDTH = 1280;
export const SCREEN_HEIGHT = 800;

export interface ScreenRecord {
  key: string;
  slot: number;
  viewToken: string;
  controlToken?: string;
  browser?: BrowserWindow;
  lastUsedAt: number;
}

const stateSchema = z.object({
  screens: z.array(
    z.object({
      key: z.string().min(1),
      slot: z
        .number()
        .int()
        .min(0)
        .max(SLOT_COUNT - 1),
      viewToken: z.string().min(1),
      browser: z.object({ browserId: z.string().min(1), windowId: z.number().int() }).optional(),
      lastUsedAt: z.number(),
    }),
  ),
});

export function resolveScreenLimit(value = process.env.MAC_SCREENS_LIMIT) {
  if (value === undefined || value === "") return 9;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > SLOT_COUNT) {
    throw new Error(`MAC_SCREENS_LIMIT must be an integer from 1 to ${SLOT_COUNT}.`);
  }
  return limit;
}

export function newToken() {
  return randomBytes(24).toString("base64url");
}

export class ScreenRegistry {
  private readonly screens = new Map<string, ScreenRecord>();
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    readonly limit: number,
  ) {}

  async load() {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return;
    }
    const state = stateSchema.parse(JSON.parse(raw));
    const slots = new Set<number>();
    for (const screen of state.screens) {
      if (slots.has(screen.slot) || screen.slot >= this.limit) continue;
      slots.add(screen.slot);
      this.screens.set(screen.key, { ...screen });
    }
  }

  get(key: string) {
    return this.screens.get(key);
  }

  list() {
    return [...this.screens.values()];
  }

  byToken(token: string): { record: ScreenRecord; control: boolean } | undefined {
    for (const record of this.screens.values()) {
      if (record.controlToken === token) return { record, control: true };
      if (record.viewToken === token) return { record, control: false };
    }
    return undefined;
  }

  async allocate(
    key: string,
    now = Date.now(),
  ): Promise<{ record: ScreenRecord; evicted?: ScreenRecord }> {
    const existing = this.screens.get(key);
    if (existing) {
      existing.lastUsedAt = now;
      await this.save();
      return { record: existing };
    }
    let evicted: ScreenRecord | undefined;
    let slot = this.freeSlot();
    if (slot === undefined) {
      evicted = this.list()
        .filter((record) => !record.controlToken)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!evicted) throw new Error("This computer cannot allocate another screen.");
      this.screens.delete(evicted.key);
      slot = evicted.slot;
    }
    const record = { key, slot, viewToken: newToken(), lastUsedAt: now };
    this.screens.set(key, record);
    await this.save();
    return { record, ...(evicted ? { evicted } : {}) };
  }

  async touch(key: string, now = Date.now()) {
    const record = this.screens.get(key);
    if (!record) return;
    record.lastUsedAt = now;
    await this.save();
  }

  setControl(key: string, token: string | undefined) {
    const record = this.screens.get(key);
    if (!record) return;
    if (token) record.controlToken = token;
    else delete record.controlToken;
  }

  async setBrowser(key: string, browser: BrowserWindow) {
    const record = this.screens.get(key);
    if (!record) return;
    record.browser = browser;
    await this.save();
  }

  async remove(key: string) {
    if (this.screens.delete(key)) await this.save();
  }

  private freeSlot() {
    const used = new Set(this.list().map((record) => record.slot));
    for (let slot = 0; slot < this.limit; slot += 1) if (!used.has(slot)) return slot;
    return undefined;
  }

  private save() {
    const write = this.saving.then(() => this.write());
    this.saving = write.catch(() => undefined);
    return write;
  }

  private async write() {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const screens = this.list().map(({ key, slot, viewToken, browser, lastUsedAt }) => ({
      key,
      slot,
      viewToken,
      ...(browser ? { browser } : {}),
      lastUsedAt,
    }));
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ screens }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }
}

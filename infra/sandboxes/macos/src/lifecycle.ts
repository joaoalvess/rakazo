import type { ScreenRecord, ScreenRegistry } from "./screens.js";

export const SLEEP_AFTER_MS = 5 * 60_000;
export const SWEEP_EVERY_MS = 30_000;

export interface LifecycleTargets {
  viewers(slot: number): number;
  sleep(record: ScreenRecord): Promise<void>;
  wake(record: ScreenRecord): Promise<void>;
  onError?(record: ScreenRecord, error: Error): void;
}

export class ScreenLifecycle {
  private readonly asleep = new Set<string>();
  private readonly watchedAt = new Map<string, number>();
  private readonly turns = new Map<string, Promise<unknown>>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly registry: Pick<ScreenRegistry, "get" | "list">,
    private readonly targets: LifecycleTargets,
    private readonly now = Date.now,
    private readonly sleepAfterMs = SLEEP_AFTER_MS,
  ) {}

  isAsleep(key: string) {
    return this.asleep.has(key);
  }

  markAsleep(key: string) {
    this.asleep.add(key);
  }

  start(everyMs = SWEEP_EVERY_MS) {
    this.timer ??= setInterval(() => void this.sweep(), everyMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async sweep() {
    await Promise.all(
      this.registry.list().map((record) =>
        this.turn(record.key, async () => {
          const current = this.registry.get(record.key);
          if (!current || this.asleep.has(current.key) || !this.idle(current)) return;
          this.asleep.add(current.key);
          await this.targets
            .sleep(current)
            .catch((error: Error) => this.targets.onError?.(current, error));
        }),
      ),
    );
  }

  wake(key: string) {
    return this.turn(key, async () => {
      const record = this.registry.get(key);
      if (!record || !this.asleep.has(key)) return;
      await this.targets.wake(record);
      this.asleep.delete(key);
    });
  }

  forget(key: string) {
    this.asleep.delete(key);
    this.watchedAt.delete(key);
  }

  private idle(record: ScreenRecord) {
    const now = this.now();
    if (record.controlToken || this.targets.viewers(record.slot) > 0) {
      this.watchedAt.set(record.key, now);
      return false;
    }
    const usedAt = Math.max(record.lastUsedAt, this.watchedAt.get(record.key) ?? 0);
    return now - usedAt >= this.sleepAfterMs;
  }

  private turn(key: string, work: () => Promise<void>) {
    const next = (this.turns.get(key) ?? Promise.resolve()).then(work);
    const settled = next.catch(() => undefined);
    this.turns.set(key, settled);
    void settled.then(() => {
      if (this.turns.get(key) === settled) this.turns.delete(key);
    });
    return next;
  }
}

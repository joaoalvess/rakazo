import { describe, expect, it } from "vitest";
import { ScreenLifecycle, SLEEP_AFTER_MS } from "./lifecycle.js";
import type { ScreenRecord } from "./screens.js";

function lifecycle(records: ScreenRecord[], viewers: Record<number, number> = {}) {
  let now = 0;
  const calls: string[] = [];
  const errors: string[] = [];
  let failSleep = false;
  let release: (() => void) | undefined;
  const subject = new ScreenLifecycle(
    {
      get: (key) => records.find((record) => record.key === key),
      list: () => records,
    },
    {
      viewers: (slot) => viewers[slot] ?? 0,
      async sleep(record) {
        calls.push(`sleep ${record.key}`);
        if (release) await new Promise<void>((resolve) => (release = resolve));
        if (failSleep) throw new Error("displayd is gone");
      },
      async wake(record) {
        calls.push(`wake ${record.key}`);
      },
      onError: (record, error) => errors.push(`${record.key}: ${error.message}`),
    },
    () => now,
  );
  return {
    subject,
    calls,
    errors,
    at: (ms: number) => {
      now = ms;
    },
    failSleep: () => {
      failSleep = true;
    },
    holdSleep: () => {
      release = () => undefined;
      return () => release?.();
    },
  };
}

const record = (key: string, slot: number, lastUsedAt = 0): ScreenRecord => ({
  key,
  slot,
  viewToken: `view-${key}`,
  lastUsedAt,
});

describe("ScreenLifecycle", () => {
  it("sleeps a screen five minutes after its bot last used it", async () => {
    const screens = [record("bot-a", 0), record("bot-b", 1, 60_000)];
    const { subject, calls, at } = lifecycle(screens);
    at(SLEEP_AFTER_MS - 1);
    await subject.sweep();
    expect(calls).toEqual([]);
    at(SLEEP_AFTER_MS);
    await subject.sweep();
    await subject.sweep();
    expect(calls).toEqual(["sleep bot-a"]);
    expect(subject.isAsleep("bot-a")).toBe(true);
    expect(subject.isAsleep("bot-b")).toBe(false);
  });

  it("keeps watched and controlled screens awake and counts from when watching stopped", async () => {
    const screens = [record("bot-a", 0), { ...record("bot-b", 1), controlToken: "c" }];
    const viewers: Record<number, number> = { 0: 1 };
    const { subject, calls, at } = lifecycle(screens, viewers);
    at(SLEEP_AFTER_MS * 2);
    await subject.sweep();
    expect(calls).toEqual([]);
    viewers[0] = 0;
    at(SLEEP_AFTER_MS * 3 - 1);
    await subject.sweep();
    expect(calls).toEqual([]);
    at(SLEEP_AFTER_MS * 3);
    await subject.sweep();
    expect(calls).toEqual(["sleep bot-a"]);
  });

  it("wakes only a sleeping screen, once", async () => {
    const screens = [record("bot-a", 0)];
    const { subject, calls, at } = lifecycle(screens);
    await subject.wake("bot-a");
    at(SLEEP_AFTER_MS);
    await subject.sweep();
    await Promise.all([subject.wake("bot-a"), subject.wake("bot-a")]);
    expect(calls).toEqual(["sleep bot-a", "wake bot-a"]);
    expect(subject.isAsleep("bot-a")).toBe(false);
  });

  it("wakes a screen only after it finished falling asleep", async () => {
    const screens = [record("bot-a", 0)];
    const { subject, calls, at, holdSleep } = lifecycle(screens);
    const finish = holdSleep();
    at(SLEEP_AFTER_MS);
    const sweeping = subject.sweep();
    await Promise.resolve();
    const waking = subject.wake("bot-a");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toEqual(["sleep bot-a"]);
    finish();
    await Promise.all([sweeping, waking]);
    expect(calls).toEqual(["sleep bot-a", "wake bot-a"]);
  });

  it("leaves a screen that failed to sleep asleep, so waking repairs it", async () => {
    const screens = [record("bot-a", 0)];
    const { subject, calls, errors, at, failSleep } = lifecycle(screens);
    failSleep();
    at(SLEEP_AFTER_MS);
    await subject.sweep();
    expect(errors).toEqual(["bot-a: displayd is gone"]);
    await subject.wake("bot-a");
    expect(calls).toEqual(["sleep bot-a", "wake bot-a"]);
  });

  it("forgets a closed screen", async () => {
    const screens = [record("bot-a", 0)];
    const { subject, calls, at } = lifecycle(screens);
    at(SLEEP_AFTER_MS);
    await subject.sweep();
    subject.forget("bot-a");
    await subject.wake("bot-a");
    expect(calls).toEqual(["sleep bot-a"]);
  });
});

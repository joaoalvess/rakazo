import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CuaDriver } from "./driver.js";

let directory: string;
let driver: CuaDriver;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "macos-driver-"));
  const binary = path.join(directory, "cua-driver");
  await writeFile(
    binary,
    [
      "#!/bin/sh",
      'case "$2" in',
      `  click) echo '{"effect":"unverifiable","route":"synthetic_events"}' ;;`,
      `  press_key) echo '{"code":"delivery_failed","message":"Unknown key name: x"}' ;;`,
      `  press_refused) echo '{"code":"window_target_not_found","effect":"refused"}' ;;`,
      `  launch_app) printf '%s' "$3" ;;`,
      `  bring_to_front) echo '{"code":"bring_to_front_exact_window_verified","status":"activated"}' ;;`,
      "  denied) echo 'Permission denied' >&2; exit 1 ;;",
      "  *) echo 'plain text' ;;",
      "esac",
    ].join("\n"),
  );
  await chmod(binary, 0o755);
  driver = new CuaDriver(binary);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("CuaDriver", () => {
  it("passes the arguments as JSON and returns the result", async () => {
    expect(await driver.call("click", { pid: 1 })).toEqual({
      effect: "unverifiable",
      route: "synthetic_events",
    });
    expect(await driver.call("launch_app", { name: "Editor de Texto" })).toEqual({
      name: "Editor de Texto",
    });
    expect(await driver.call("bring_to_front", {})).toMatchObject({ status: "activated" });
  });

  it("fails on errors the driver reports", async () => {
    await expect(driver.call("press_key", {})).rejects.toThrow(
      "cua-driver press_key failed: Unknown key name: x",
    );
    await expect(driver.call("press_refused", {})).rejects.toMatchObject({
      code: "window_target_not_found",
    });
    await expect(driver.call("denied", {})).rejects.toThrow(/Permission denied/);
    await expect(driver.call("other", {})).rejects.toThrow(/without JSON/);
  });
});

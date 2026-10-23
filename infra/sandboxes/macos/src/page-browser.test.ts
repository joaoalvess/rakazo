import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PageBrowser } from "./page-browser.js";

let directory: string;
let script: string;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "macos-page-browser-"));
  script = path.join(directory, "rakazo-page-browser");
  await writeFile(
    script,
    [
      "#!/bin/sh",
      "read -r line",
      'case "$1" in',
      `  snapshot) printf '{"ok":true,"window":"%s","port":"%s","stdin":"%s","home":"%s","args":%s}' "$RAKAZO_CDP_WINDOW_ID" "$RAKAZO_CDP_PORT" "$RAKAZO_BROWSER_ARGS_STDIN" "$HOME" "$line" ;;`,
      "  navigate) cat > /dev/null; exit 130 ;;",
      "  act) head -c 600000 /dev/zero | tr '\\0' a ;;",
      "esac",
    ].join("\n"),
  );
  await chmod(script, 0o755);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("PageBrowser", () => {
  it("sends the command over stdin to the helper bound to the bot's window", async () => {
    const browser = new PageBrowser(script, {
      HOME: "/Users/joaoalves",
      RAKAZO_CDP_PORT: "9333",
      PATH: process.env.PATH!,
    });
    expect(await browser.run({ command: "snapshot" }, 1981)).toEqual({
      ok: true,
      window: "1981",
      port: "9333",
      stdin: "1",
      home: "/Users/joaoalves",
      args: { command: "snapshot" },
    });
    expect(
      await browser.run({ command: "snapshot" }, 1981, undefined, "/Users/joaoalves/data/bot-a"),
    ).toMatchObject({ home: "/Users/joaoalves/data/bot-a" });
  });

  it("closes the helper's stdin when it runs out of time", async () => {
    const browser = new PageBrowser(script, { PATH: process.env.PATH! }, 100);
    await expect(
      browser.run({ command: "navigate", url: "https://example.com" }, 1),
    ).rejects.toThrow("Page browser timed out; the page may be busy or blocked by a dialog. Retry");
  });

  it("closes the helper's stdin when the request is cancelled", async () => {
    const browser = new PageBrowser(script, { PATH: process.env.PATH! });
    const controller = new AbortController();
    const run = browser.run(
      { command: "navigate", url: "https://example.com" },
      1,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);
    await expect(run).rejects.toThrow("Page browser unavailable or interrupted");
  });

  it("refuses output larger than the limit", async () => {
    const browser = new PageBrowser(script, { PATH: process.env.PATH! });
    await expect(browser.run({ command: "act", actions: [] }, 1)).rejects.toThrow(
      "Page browser unavailable or interrupted",
    );
  });
});

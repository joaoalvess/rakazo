import { spawn } from "node:child_process";

const TIMEOUT_MS = 25_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

export type PageBrowserCommand =
  | { command: "navigate"; url: string }
  | { command: "snapshot" }
  | { command: "act"; actions: Array<Record<string, unknown>> };

export class PageBrowser {
  constructor(
    private readonly script: string,
    private readonly env: Record<string, string>,
    private readonly timeoutMs = TIMEOUT_MS,
  ) {}

  async run(command: PageBrowserCommand, windowId: number, signal?: AbortSignal, home?: string) {
    const { code, stdout, timedOut } = await this.spawn(command, windowId, signal, home);
    if (code !== 0 || stdout === undefined) {
      throw new Error(
        timedOut
          ? `Page browser timed out; the page may be busy or blocked by a dialog. ${
              command.command === "act"
                ? "Inspect the screen before continuing."
                : "Retry once before using other tools."
            }`
          : "Page browser unavailable or interrupted",
      );
    }
    return JSON.parse(stdout) as unknown;
  }

  private spawn(
    command: PageBrowserCommand,
    windowId: number,
    signal?: AbortSignal,
    home?: string,
  ) {
    return new Promise<{ code: number | null; stdout?: string; timedOut: boolean }>(
      (resolve, reject) => {
        signal?.throwIfAborted();
        const child = spawn(this.script, [command.command], {
          env: {
            ...this.env,
            ...(home ? { HOME: home } : {}),
            RAKAZO_CDP_WINDOW_ID: String(windowId),
            RAKAZO_BROWSER_WATCH_STDIN: "1",
            RAKAZO_BROWSER_ARGS_STDIN: "1",
          },
          stdio: ["pipe", "pipe", "ignore"],
        });
        const chunks: Buffer[] = [];
        let size = 0;
        let timedOut = false;
        const cancel = () => child.stdin.end();
        const timer = setTimeout(() => {
          timedOut = true;
          cancel();
        }, this.timeoutMs);
        signal?.addEventListener("abort", cancel, { once: true });
        child.stdin.on("error", () => undefined);
        child.stdout.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_OUTPUT_BYTES) child.kill();
          else chunks.push(chunk);
        });
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
        };
        child.on("error", (error) => {
          finish();
          reject(error);
        });
        child.on("close", (code) => {
          finish();
          resolve({
            code,
            timedOut,
            stdout: size > MAX_OUTPUT_BYTES ? undefined : Buffer.concat(chunks).toString("utf8"),
          });
        });
        child.stdin.write(`${JSON.stringify(command)}\n`);
      },
    );
  }
}

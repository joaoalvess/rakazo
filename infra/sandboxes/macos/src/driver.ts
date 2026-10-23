import { execFile } from "node:child_process";

export type DriverResult = Record<string, unknown>;

export class DriverError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export class CuaDriver {
  constructor(
    private readonly binary: string,
    private readonly timeoutMs = 20_000,
  ) {}

  call(tool: string, args: Record<string, unknown>): Promise<DriverResult> {
    return new Promise((resolve, reject) => {
      execFile(
        this.binary,
        ["call", tool, JSON.stringify(args)],
        { timeout: this.timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(`cua-driver ${tool} failed: ${(stderr || stdout || error.message).trim()}`),
            );
            return;
          }
          let result: DriverResult;
          try {
            result = JSON.parse(stdout);
          } catch {
            reject(
              new Error(`cua-driver ${tool} answered without JSON: ${stdout.trim().slice(0, 200)}`),
            );
            return;
          }
          if (failed(result)) {
            reject(
              new DriverError(
                `cua-driver ${tool} failed: ${result.message ?? result.reason ?? result.code}`,
                typeof result.code === "string" ? result.code : undefined,
              ),
            );
            return;
          }
          resolve(result);
        },
      );
    });
  }
}

function failed(result: DriverResult) {
  if (result.effect === "refused") return true;
  return (
    typeof result.code === "string" && result.effect === undefined && result.status === undefined
  );
}

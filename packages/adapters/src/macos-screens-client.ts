import type {
  AdapterContext,
  ComputerActionRequest,
  ComputerActionResult,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ControlLeaseRef,
  PageBrowserCommand,
  PageBrowserResult,
  ScreenRequest,
  ScreenSession,
} from "@rakazo/adapter-kit";
import { outgoingCorrelationHeaders } from "@rakazo/logging";
import { boundedComputerActions, clampRounded, computerObservation } from "./computer-support.js";
import { readSandboxJson, SCREEN_RELEASE_TIMEOUT_MS, safeBody } from "./docker-sandbox.js";

interface ObservationBody {
  image: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  cursor?: { x: number; y: number };
  activeWindow?: { id: string; title?: string };
}

export class MacScreensClient {
  constructor(
    private readonly supervisorUrl: string,
    private readonly supervisorToken: string,
  ) {}

  async pageBrowser(
    computer: ComputerRef,
    home: string,
    request: PageBrowserCommand,
    context: AdapterContext,
  ): Promise<PageBrowserResult> {
    const res = await fetch(this.url(computer, "browser"), {
      method: "POST",
      headers: {
        ...this.headers(computer, context),
        "content-type": "application/json",
        "x-rakazo-computer-home": encodeURIComponent(home),
      },
      body: JSON.stringify(request),
      redirect: "error",
      signal: context.signal,
    });
    if (!res.ok) throw new Error(`page browser failed: ${res.status}`);
    return readSandboxJson<PageBrowserResult>(res, context.signal, 512 * 1024);
  }

  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    if (request.interactive && !request.controlToken) {
      throw new Error("interactive screen requires a control token");
    }
    const res = await fetch(this.url(computer, "screen-mode"), {
      method: "POST",
      headers: { ...this.headers(computer, context), "content-type": "application/json" },
      body: JSON.stringify({
        interactive: request.interactive === true,
        controlToken: request.controlToken,
        revokeControl: false,
      }),
      signal: context.signal,
    });
    if (!res.ok) {
      const detail = await safeBody(res, context.signal);
      if (/cannot allocate another screen/i.test(detail)) {
        throw new Error("This Mac cannot allocate another screen.");
      }
      if (request.interactive) {
        throw new Error(`computer screen mode failed: ${res.status} ${detail}`.trim());
      }
      return { url: null, mimeType: "text/html", close: async () => undefined };
    }
    const body = await readSandboxJson<{ screenUrl?: string; asleep?: boolean }>(
      res,
      context.signal,
    );
    if (!body.screenUrl) {
      if (request.interactive) throw new Error("control screen failed to start");
      return { url: null, mimeType: "text/html", close: async () => undefined };
    }
    return {
      url: body.screenUrl,
      mimeType: "text/html",
      ...(body.asleep ? { asleep: true } : {}),
      close: async () => undefined,
    };
  }

  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ) {
    const res = await fetch(this.url(computer, "screen-mode"), {
      method: "POST",
      headers: { ...this.headers(computer, context), "content-type": "application/json" },
      body: JSON.stringify({ interactive, controlToken }),
      signal: context.signal,
    });
    if (!res.ok) {
      const detail = await safeBody(res, context.signal);
      throw new Error(`computer screen mode failed: ${res.status} ${detail}`.trim());
    }
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    const res = await fetch(this.url(computer, "input"), {
      method: "POST",
      headers: { ...this.headers(computer, context), "content-type": "application/json" },
      body: JSON.stringify({ input, leaseId: lease.leaseId }),
      signal: context.signal,
    });
    if (!res.ok) {
      const detail = await safeBody(res, context.signal);
      throw new Error(`computer input failed: ${res.status} ${detail}`.trim());
    }
  }

  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    const res = await fetch(this.url(computer, "observe"), {
      method: "POST",
      headers: this.headers(computer, context),
      signal: context.signal,
    });
    if (!res.ok)
      throw new Error(
        `computer observation failed: ${res.status} ${await safeBody(res, context.signal)}`.trim(),
      );
    return observation(await readSandboxJson<ObservationBody>(res, context.signal));
  }

  async act(
    computer: ComputerRef,
    request: ComputerActionRequest,
    context: AdapterContext,
  ): Promise<ComputerActionResult> {
    const res = await fetch(this.url(computer, "actions"), {
      method: "POST",
      headers: { ...this.headers(computer, context), "content-type": "application/json" },
      body: JSON.stringify({
        actions: boundedComputerActions(request.actions),
        observe: request.observe,
        settleMs: clampRounded(request.settleMs ?? 0, 0, 5_000),
      }),
      signal: context.signal,
    });
    if (!res.ok)
      throw new Error(
        `computer action failed: ${res.status} ${await safeBody(res, context.signal)}`.trim(),
      );
    const body = await readSandboxJson<{ completed: number; observation?: ObservationBody }>(
      res,
      context.signal,
    );
    return {
      completed: body.completed,
      ...(body.observation ? { observation: observation(body.observation) } : {}),
    };
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    if (!context.botId) return;
    const signal = AbortSignal.timeout(SCREEN_RELEASE_TIMEOUT_MS);
    const res = await fetch(this.url(computer, "screen"), {
      method: "DELETE",
      headers: this.headers(computer, context),
      signal,
    });
    if (!res.ok) {
      const detail = await safeBody(res, signal);
      throw new Error(`computer screen release failed: ${res.status} ${detail}`.trim());
    }
  }

  async wakeScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    if (!context.botId) return;
    const res = await fetch(this.url(computer, "screen/wake"), {
      method: "POST",
      headers: this.headers(computer, context),
      signal: context.signal,
    });
    if (res.status === 404 || res.ok) return;
    const detail = await safeBody(res, context.signal);
    throw new Error(`computer screen wake failed: ${res.status} ${detail}`.trim());
  }

  async resetScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    if (!context.botId) return;
    const res = await fetch(this.url(computer, "screen/reset"), {
      method: "POST",
      headers: this.headers(computer, context),
      signal: context.signal,
    });
    if (!res.ok) {
      const detail = await safeBody(res, context.signal);
      throw new Error(`computer screen reset failed: ${res.status} ${detail}`.trim());
    }
  }

  private url(computer: ComputerRef, route: string) {
    return `${this.supervisorUrl.replace(/\/$/, "")}/computers/${encodeURIComponent(computer.id)}/${route}`;
  }

  private headers(computer: ComputerRef, context: AdapterContext) {
    return {
      authorization: `Bearer ${this.supervisorToken}`,
      "x-rakazo-space-id": context.spaceId,
      ...outgoingCorrelationHeaders(),
      "x-rakazo-bot-id": computer.botId,
      ...(context.botId ? { "x-rakazo-screen-id": context.botId } : {}),
    };
  }
}

function observation(body: ObservationBody): ComputerObservation {
  return computerObservation(Uint8Array.from(Buffer.from(body.image, "base64")), body);
}

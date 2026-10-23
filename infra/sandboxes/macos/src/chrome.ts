import { CdpConnection } from "./cdp.js";
import type { Rect } from "./displayd.js";

export interface BrowserWindow {
  browserId: string;
  windowId: number;
}

export interface PageView {
  rect: Rect;
  scale: number;
  window: Rect;
  pid: number;
  send(method: string, params: object): Promise<unknown>;
}

interface WindowBounds {
  left: number;
  top: number;
  width: number;
  height: number;
  windowState?: string;
}

interface Geometry {
  visible: boolean;
  x: number;
  y: number;
  outerWidth: number;
  outerHeight: number;
  innerWidth: number;
  innerHeight: number;
  scale: number;
}

const GEOMETRY =
  "({ visible: document.visibilityState === 'visible', x: screenX, y: screenY, outerWidth, outerHeight, innerWidth, innerHeight, scale: devicePixelRatio })";

export class Chrome {
  private connection?: Promise<{ cdp: CdpConnection; browserId: string; pid: number }>;
  private readonly sessions = new Map<string, Promise<string>>();

  constructor(private readonly endpoint: string) {}

  async placeWindow(window: BrowserWindow | undefined, display: Rect): Promise<BrowserWindow> {
    const { cdp, browserId } = await this.connect();
    let windowId = window?.browserId === browserId ? window.windowId : undefined;
    const bounds = windowId === undefined ? undefined : await this.bounds(cdp, windowId);
    if (!bounds) {
      const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", {
        url: "about:blank",
        newWindow: true,
      });
      ({ windowId } = await cdp.send<{ windowId: number }>("Browser.getWindowForTarget", {
        targetId,
      }));
    }
    if (!bounds || !centeredIn(bounds, display)) {
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { left: display.x, top: display.y, width: display.width, height: display.height },
      });
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "maximized" } });
    } else if (bounds.windowState !== "maximized") {
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "maximized" } });
    }
    return { browserId, windowId: windowId! };
  }

  async pageView(window: BrowserWindow): Promise<PageView | undefined> {
    const { cdp, browserId, pid } = await this.connect();
    if (window.browserId !== browserId) return undefined;
    for (const page of await this.pagesIn(cdp, window.windowId)) {
      const view = await this.view(cdp, page, pid).catch(() => undefined);
      if (view) return view;
    }
    return undefined;
  }

  async closeWindow(window: BrowserWindow) {
    const { cdp, browserId } = await this.connect();
    if (window.browserId !== browserId) return;
    for (const { targetId } of await this.pagesIn(cdp, window.windowId)) {
      await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
    }
  }

  close() {
    void this.connection?.then(
      ({ cdp }) => cdp.close(),
      () => undefined,
    );
  }

  private async pagesIn(cdp: CdpConnection, windowId: number) {
    const { targetInfos } = await cdp.send<{
      targetInfos: Array<{ targetId: string; type: string }>;
    }>("Target.getTargets");
    const pages: Array<{ targetId: string; bounds: WindowBounds }> = [];
    for (const target of targetInfos) {
      if (target.type !== "page") continue;
      const owner = await cdp
        .send<{ windowId: number; bounds: WindowBounds }>("Browser.getWindowForTarget", {
          targetId: target.targetId,
        })
        .catch(() => undefined);
      if (owner?.windowId === windowId)
        pages.push({ targetId: target.targetId, bounds: owner.bounds });
    }
    return pages;
  }

  private async view(
    cdp: CdpConnection,
    { targetId, bounds }: { targetId: string; bounds: WindowBounds },
    pid: number,
  ): Promise<PageView | undefined> {
    const sessionId = await this.session(cdp, targetId);
    const { result } = await cdp.send<{ result: { value?: Geometry } }>(
      "Runtime.evaluate",
      { expression: GEOMETRY, returnByValue: true },
      sessionId,
      1_000,
    );
    const geometry = result.value;
    if (!geometry?.visible) return undefined;
    const width = geometry.innerWidth * geometry.scale;
    const height = geometry.innerHeight * geometry.scale;
    return {
      rect: {
        x: geometry.x + (geometry.outerWidth - width) / 2,
        y: geometry.y + geometry.outerHeight - height,
        width,
        height,
      },
      scale: geometry.scale,
      window: { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height },
      pid,
      send: (method, params) => cdp.send(method, params, sessionId),
    };
  }

  private bounds(cdp: CdpConnection, windowId: number) {
    return cdp
      .send<{ bounds: WindowBounds }>("Browser.getWindowBounds", { windowId })
      .then(({ bounds }) => bounds)
      .catch(() => undefined);
  }

  private session(cdp: CdpConnection, targetId: string) {
    let session = this.sessions.get(targetId);
    if (!session) {
      session = cdp
        .send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })
        .then(({ sessionId }) => sessionId);
      session.catch(() => this.sessions.delete(targetId));
      this.sessions.set(targetId, session);
    }
    return session;
  }

  private connect() {
    if (!this.connection) {
      const connection = this.open();
      this.connection = connection;
      connection.then(
        ({ cdp }) => void cdp.closed.then(() => this.reset(connection)),
        () => this.reset(connection),
      );
    }
    return this.connection;
  }

  private reset(connection: Promise<unknown>) {
    if (this.connection !== connection) return;
    this.connection = undefined;
    this.sessions.clear();
  }

  private async open() {
    const response = await fetch(new URL("/json/version", this.endpoint), {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`Chrome DevTools answered ${response.status}`);
    const { webSocketDebuggerUrl } = (await response.json()) as { webSocketDebuggerUrl: string };
    const cdp = await CdpConnection.open(webSocketDebuggerUrl);
    cdp.on((event) => {
      if (
        event.method === "Target.detachedFromTarget" &&
        typeof event.params.targetId === "string"
      ) {
        this.sessions.delete(event.params.targetId);
      }
    });
    const { processInfo } = await cdp
      .send<{ processInfo: Array<{ type: string; id: number }> }>("SystemInfo.getProcessInfo")
      .catch(() => ({ processInfo: [] }));
    return {
      cdp,
      browserId: new URL(webSocketDebuggerUrl).pathname.split("/").pop() ?? "",
      pid: processInfo.find((process) => process.type === "browser")?.id ?? 0,
    };
  }
}

function centeredIn(bounds: WindowBounds, display: Rect) {
  const x = bounds.left + bounds.width / 2;
  const y = bounds.top + bounds.height / 2;
  return (
    x >= display.x &&
    x < display.x + display.width &&
    y >= display.y &&
    y < display.y + display.height
  );
}

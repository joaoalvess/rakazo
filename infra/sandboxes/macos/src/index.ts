import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { resolveSupervisorToken } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { SERVICE_NAMES } from "@rakazo/logging";
import { createRootLogger } from "@rakazo/logging/axiom";
import { BotComputer } from "./actions.js";
import { createApi, type ScreenService } from "./api.js";
import { Chrome } from "./chrome.js";
import { DisplaydClient, type Rect } from "./displayd.js";
import { CuaDriver } from "./driver.js";
import { ScreenFeeds, stillFrame } from "./feed.js";
import { ControlInput } from "./input.js";
import { ScreenLifecycle } from "./lifecycle.js";
import { PageBrowser } from "./page-browser.js";
import {
  resolveScreenLimit,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  type ScreenRecord,
  ScreenRegistry,
} from "./screens.js";
import { TakeoverInput } from "./takeover.js";
import { createViewerServer } from "./viewer.js";

loadRootEnv();

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const dataDir = path.resolve(repositoryRoot, process.env.DATA_DIR ?? "./data");
const stateDir = path.join(dataDir, "macos-screens");

export async function startMacScreens() {
  const logger = createRootLogger(SERVICE_NAMES.macScreens);
  const supervisorToken = resolveSupervisorToken(process.env);
  const hostname = process.env.MAC_SCREENS_HOST ?? "127.0.0.1";
  const apiPort = Number(process.env.MAC_SCREENS_PORT ?? 7092);
  const viewerPort = Number(process.env.MAC_SCREENS_VIEWER_PORT ?? 7093);
  const novncRoot = process.env.MAC_SCREENS_NOVNC_DIR ?? path.join(stateDir, "novnc");
  if (!existsSync(path.join(novncRoot, "core", "rfb.js"))) {
    throw new Error(
      `noVNC is missing from ${novncRoot}. Run infra/sandboxes/macos/fetch-novnc.sh ${novncRoot}`,
    );
  }
  const displayd = new DisplaydClient(
    process.env.MAC_SCREENS_DISPLAYD_DIR ??
      path.join(homedir(), "Library", "Application Support", "Rakazo", "displayd"),
  );
  const chromePort = process.env.MAC_SCREENS_CHROME_PORT ?? "9333";
  const chrome = new Chrome(`http://127.0.0.1:${chromePort}`);
  const pageBrowser = new PageBrowser(
    path.join(repositoryRoot, "infra", "sandboxes", "computer", "rakazo-page-browser"),
    {
      HOME: homedir(),
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      RAKAZO_CDP_PORT: chromePort,
      ...(process.env.RAKAZO_BROWSER_UPLOAD_MAX_BYTES !== undefined
        ? { RAKAZO_BROWSER_UPLOAD_MAX_BYTES: process.env.RAKAZO_BROWSER_UPLOAD_MAX_BYTES }
        : {}),
    },
  );
  const driver = new CuaDriver(process.env.MAC_SCREENS_CUA_DRIVER ?? "cua-driver");
  const registry = new ScreenRegistry(path.join(stateDir, "state.json"), resolveScreenLimit());
  await registry.load();
  const screenBounds = async (slot: number) => {
    const { screens } = await displayd.call({ op: "status" });
    const screen = screens?.find((candidate) => candidate.slot === slot);
    if (!screen) throw new Error(`screen ${slot} is not open`);
    return screen.bounds;
  };
  const browserPage = async (key: string) => {
    const browser = registry.get(key)?.browser;
    return browser ? chrome.pageView(browser) : undefined;
  };
  const screenWindows = async (slot: number) =>
    (await displayd.call({ op: "windows", slot })).windows ?? [];
  const feeds = new ScreenFeeds(displayd, {
    fps: 30,
    quality: 0.6,
    onError: (slot, error) => logger.warn("screen capture ended", { slot, reason: error.message }),
  });
  const viewer = createViewerServer({
    embedRoot: path.join(repositoryRoot, "infra", "sandboxes", "computer"),
    novncRoot,
    feeds,
    authorize: (token) => {
      const match = registry.byToken(token);
      if (!match) return undefined;
      return {
        screenKey: match.record.key,
        slot: match.record.slot,
        control: match.control,
        width: SCREEN_WIDTH,
        height: SCREEN_HEIGHT,
      };
    },
    controlInput: (grant) => {
      const warn = (error: Error) =>
        logger.warn("takeover input failed", { slot: grant.slot, reason: error.message });
      void displayd.call({ op: "takeover", slot: grant.slot, active: true }).catch(warn);
      void displayd.call({ op: "overlay", slot: grant.slot, cursorHidden: true }).catch(warn);
      const takeover = new TakeoverInput(
        {
          display: () => screenBounds(grant.slot),
          page: () => browserPage(grant.screenKey),
          windows: () => screenWindows(grant.slot),
          native: (events) => displayd.call({ op: "input", slot: grant.slot, events }),
        },
        warn,
      );
      const input = new ControlInput((events) => takeover.send(events));
      return { handle: (event) => input.handle(event), close: () => takeover.release() };
    },
  });

  const placeBrowser = async (record: ScreenRecord, display: Rect, show = false) => {
    try {
      await registry.setBrowser(
        record.key,
        await chrome.placeWindow(record.browser, display, show),
      );
    } catch (error) {
      logger.warn("browser window unavailable", {
        screen: record.key,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  let foregroundTurn: Promise<unknown> = Promise.resolve();
  const foreground = <T>(work: () => Promise<T>) => {
    const turn = foregroundTurn.then(work);
    foregroundTurn = turn.catch(() => undefined);
    return turn;
  };
  const computers = new Map<string, BotComputer>();
  const computer = (record: ScreenRecord) => {
    let current = computers.get(record.key);
    if (!current) {
      current = new BotComputer({
        display: () => screenBounds(record.slot),
        otherDisplays: async () =>
          ((await displayd.call({ op: "status" })).screens ?? [])
            .filter((screen) => screen.slot !== record.slot)
            .map((screen) => screen.bounds),
        page: () => browserPage(record.key),
        windows: () => screenWindows(record.slot),
        driver: (tool, args) => driver.call(tool, args),
        raise: (pid, window) => displayd.call({ op: "raise", pid, window }),
        foreground,
        browser: async (visible) => {
          const current = registry.get(record.key);
          if (!current) return;
          if (visible) await placeBrowser(current, await screenBounds(record.slot), true);
          else if (current.browser) await chrome.hideWindow(current.browser);
        },
        overlay: (update) => displayd.call({ op: "overlay", slot: record.slot, ...update }),
      });
      computers.set(record.key, current);
    }
    return current;
  };

  const hiddenWhileAsleep = new Set<string>();
  const lifecycle = new ScreenLifecycle(registry, {
    viewers: (slot) => feeds.viewers(slot),
    async sleep(record) {
      const shot = await displayd.call({
        op: "screenshot",
        slot: record.slot,
        format: "jpeg",
        quality: 0.7,
      });
      if (!shot.image) throw new Error("displayd returned no screenshot");
      feeds.sleep(
        record.slot,
        stillFrame(Buffer.from(shot.image, "base64"), SCREEN_WIDTH, SCREEN_HEIGHT),
      );
      await displayd.call({ op: "sleep", slot: record.slot });
      if (record.browser) {
        if (await chrome.pageView(record.browser)) {
          await chrome.hideWindow(record.browser);
          hiddenWhileAsleep.add(record.key);
        }
        await chrome.freezeWindow(record.browser, true);
      }
      logger.info("screen asleep", { screen: record.key, slot: record.slot });
    },
    async wake(record) {
      const { screen } = await displayd.call({ op: "wake", slot: record.slot });
      if (record.browser) {
        await chrome.freezeWindow(record.browser, false);
        if (hiddenWhileAsleep.delete(record.key) && screen) {
          await placeBrowser(record, screen.bounds, true);
        }
      }
      feeds.wake(record.slot);
      logger.info("screen awake", { screen: record.key, slot: record.slot });
    },
    onError: (record, error) =>
      logger.warn("screen failed to sleep", { screen: record.key, reason: error.message }),
  });
  const asleepSlots = await displayd
    .call({ op: "status" })
    .then(({ screens }) =>
      (screens ?? []).filter((screen) => !screen.awake).map((screen) => screen.slot),
    )
    .catch((): number[] => []);
  for (const record of registry.list()) {
    if (asleepSlots.includes(record.slot)) lifecycle.markAsleep(record.key);
  }
  lifecycle.start();

  const closeScreen = async (record: ScreenRecord) => {
    lifecycle.forget(record.key);
    hiddenWhileAsleep.delete(record.key);
    computers.delete(record.key);
    viewer.revoke((grant) => grant.screenKey === record.key);
    feeds.close(record.slot);
    if (record.browser) await chrome.closeWindow(record.browser).catch(() => undefined);
    await displayd.call({ op: "close", slot: record.slot });
  };

  const openScreen = async (key: string) => {
    const { record, evicted } = await registry.allocate(key);
    if (evicted) {
      logger.info("screen evicted", { screen: evicted.key, slot: evicted.slot });
      await closeScreen(evicted);
    }
    await lifecycle.wake(key);
    const { screen } = await displayd.call({ op: "open", slot: record.slot });
    if (screen) await placeBrowser(record, screen.bounds);
    return record;
  };

  const service: ScreenService = {
    async reset(key) {
      const record = registry.get(key);
      if (!record) return;
      if (record.controlToken) await service.revokeControl(record);
      await closeScreen(record);
      await registry.remove(key);
      logger.info("screen reset", { screen: key, slot: record.slot });
    },
    registry,
    viewerUrl: `http://${hostname}:${viewerPort}/embed.html`,
    openScreen,
    async observe(key) {
      const record = await openScreen(key);
      const bot = computer(record);
      const [shot, activeWindow] = await Promise.all([
        displayd.call({ op: "screenshot", slot: record.slot, format: "png" }),
        bot.activeWindow().catch(() => undefined),
      ]);
      if (!shot.image) throw new Error("displayd returned no screenshot");
      return {
        image: shot.image,
        mimeType: shot.mimeType ?? "image/png",
        width: SCREEN_WIDTH,
        height: SCREEN_HEIGHT,
        cursor: bot.position,
        ...(activeWindow ? { activeWindow } : {}),
      };
    },
    async act(key, actions) {
      return computer(await openScreen(key)).act(actions);
    },
    async browser(key, command, signal, home) {
      return computer(await openScreen(key)).usePage(() => {
        const window = registry.get(key)?.browser;
        if (!window) throw new Error("the bot's browser window is not available");
        return pageBrowser.run(command, window.windowId, signal, home);
      });
    },
    async wake(key) {
      await openScreen(key);
    },
    asleep: (key) => lifecycle.isAsleep(key),
    async revokeControl(record) {
      registry.setControl(record.key, undefined);
      viewer.revoke((grant) => grant.screenKey === record.key && grant.control);
      await displayd
        .call({ op: "takeover", slot: record.slot, active: false })
        .catch(() => undefined);
      await displayd
        .call({ op: "overlay", slot: record.slot, cursorHidden: false })
        .catch(() => undefined);
    },
  };

  serve({ fetch: createApi(service, supervisorToken).fetch, hostname, port: apiPort }, () => {
    logger.info("macOS screens listening", { "http.host": hostname, "http.port": apiPort });
  });
  viewer.server.listen(viewerPort, hostname, () => {
    logger.info("macOS screen viewer listening", {
      "http.host": hostname,
      "http.port": viewerPort,
    });
  });
  const shutdown = async () => {
    lifecycle.stop();
    chrome.close();
    await viewer.close();
    await logger.flush({ timeoutMs: 2_000 });
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startMacScreens().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

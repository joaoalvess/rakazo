import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { resolveSupervisorToken } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { SERVICE_NAMES } from "@rakazo/logging";
import { createRootLogger } from "@rakazo/logging/axiom";
import { createApi, type ScreenService } from "./api.js";
import { Chrome } from "./chrome.js";
import { DisplaydClient, type Rect } from "./displayd.js";
import { ScreenFeeds } from "./feed.js";
import { ControlInput } from "./input.js";
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
  const chrome = new Chrome(`http://127.0.0.1:${process.env.MAC_SCREENS_CHROME_PORT ?? 9333}`);
  const registry = new ScreenRegistry(path.join(stateDir, "state.json"), resolveScreenLimit());
  await registry.load();
  const feeds = new ScreenFeeds(displayd, {
    fps: 30,
    quality: 0.6,
    onError: (slot, error) => logger.warn("screen capture ended", { slot, error: error.message }),
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
        logger.warn("takeover input failed", { slot: grant.slot, error: error.message });
      void displayd.call({ op: "takeover", slot: grant.slot, active: true }).catch(warn);
      void displayd.call({ op: "overlay", slot: grant.slot, cursorHidden: true }).catch(warn);
      const takeover = new TakeoverInput(
        {
          display: async () => {
            const { screens } = await displayd.call({ op: "status" });
            const screen = screens?.find((candidate) => candidate.slot === grant.slot);
            if (!screen) throw new Error(`screen ${grant.slot} is not open`);
            return screen.bounds;
          },
          page: async () => {
            const browser = registry.get(grant.screenKey)?.browser;
            return browser ? chrome.pageView(browser) : undefined;
          },
          windows: async () =>
            (await displayd.call({ op: "windows", slot: grant.slot })).windows ?? [],
          native: (events) => displayd.call({ op: "input", slot: grant.slot, events }),
        },
        warn,
      );
      const input = new ControlInput((events) => takeover.send(events));
      return { handle: (event) => input.handle(event), close: () => takeover.release() };
    },
  });

  const placeBrowser = async (record: ScreenRecord, display: Rect) => {
    try {
      await registry.setBrowser(record.key, await chrome.placeWindow(record.browser, display));
    } catch (error) {
      logger.warn("browser window unavailable", {
        screen: record.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const closeScreen = async (record: ScreenRecord) => {
    viewer.revoke((grant) => grant.screenKey === record.key);
    feeds.close(record.slot);
    if (record.browser) await chrome.closeWindow(record.browser).catch(() => undefined);
    await displayd.call({ op: "close", slot: record.slot });
  };

  const service: ScreenService = {
    registry,
    viewerUrl: `http://${hostname}:${viewerPort}/embed.html`,
    async openScreen(key) {
      const { record, evicted } = await registry.allocate(key);
      if (evicted) {
        logger.info("screen evicted", { screen: evicted.key, slot: evicted.slot });
        await closeScreen(evicted);
      }
      const { screen } = await displayd.call({ op: "open", slot: record.slot });
      if (screen) await placeBrowser(record, screen.bounds);
      return record;
    },
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

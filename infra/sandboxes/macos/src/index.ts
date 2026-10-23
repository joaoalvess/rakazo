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
import { DisplaydClient } from "./displayd.js";
import { ScreenFeeds } from "./feed.js";
import { ControlInput } from "./input.js";
import {
  resolveScreenLimit,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  type ScreenRecord,
  ScreenRegistry,
} from "./screens.js";
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
      const input = new ControlInput((events) => {
        void displayd.call({ op: "input", slot: grant.slot, events }).catch(warn);
      });
      return (event) => input.handle(event);
    },
  });

  const closeScreen = async (record: ScreenRecord) => {
    viewer.revoke((grant) => grant.screenKey === record.key);
    feeds.close(record.slot);
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
      await displayd.call({ op: "open", slot: record.slot });
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

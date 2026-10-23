import path from "node:path";
import { hasValidBearerToken } from "@rakazo/core";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { ComputerAction, Point } from "./actions.js";
import type { PageBrowserCommand } from "./page-browser.js";
import type { ScreenRecord, ScreenRegistry } from "./screens.js";

export interface Observation {
  image: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  cursor?: Point;
  activeWindow?: { id: string; title?: string };
}

export interface ScreenService {
  registry: ScreenRegistry;
  viewerUrl: string;
  openScreen(key: string): Promise<ScreenRecord>;
  revokeControl(record: ScreenRecord): Promise<void>;
  observe(key: string): Promise<Observation>;
  act(key: string, actions: ComputerAction[]): Promise<number>;
  browser(
    key: string,
    command: PageBrowserCommand,
    signal?: AbortSignal,
    home?: string,
  ): Promise<unknown>;
  wake(key: string): Promise<void>;
  asleep(key: string): boolean;
  reset(key: string): Promise<void>;
}

const pointerSchema = z.object({
  kind: z.literal("pointer"),
  x: z.number(),
  y: z.number(),
  button: z.enum(["left", "right"]).optional(),
  type: z.enum(["move", "down", "up", "click"]),
});

const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("key"), key: z.string(), modifiers: z.array(z.string()).optional() }),
  pointerSchema,
  z.object({ kind: z.literal("clipboard"), text: z.string() }),
  z.object({
    kind: z.literal("scroll"),
    direction: z.enum(["up", "down"]),
    amount: z.number().optional(),
  }),
  z.object({ kind: z.literal("wait"), ms: z.number() }),
  z.object({ kind: z.literal("open"), path: z.string() }),
  z.object({ kind: z.literal("launch"), application: z.string(), uri: z.string().optional() }),
  z.object({ kind: z.literal("focus"), application: z.string(), uri: z.string().optional() }),
]);

const actionsSchema = z.object({
  actions: z.array(actionSchema).max(24),
  observe: z.boolean().optional(),
  settleMs: z.number().min(0).max(5_000).optional(),
});

const inputSchema = z.object({
  input: z.object({
    kind: z.enum(["key", "pointer", "clipboard"]),
    key: z.string().optional(),
    modifiers: z.array(z.string()).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    button: z.enum(["left", "right"]).optional(),
    type: z.enum(["move", "down", "up", "click"]).optional(),
    text: z.string().optional(),
  }),
  leaseId: z.string().optional(),
});

const browserSchema = z.discriminatedUnion("command", [
  z.object({
    command: z.literal("navigate"),
    url: z
      .string()
      .url()
      .max(8192)
      .refine((value) => {
        if (!URL.canParse(value)) return false;
        const url = new URL(value);
        return /^https?:$/.test(url.protocol) && !url.username && !url.password;
      }),
  }),
  z.object({ command: z.literal("snapshot") }),
  z.object({
    command: z.literal("act"),
    actions: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("click"), ref: z.string().min(1).max(200) }),
          z.object({
            kind: z.literal("upload"),
            ref: z.string().min(1).max(200),
            paths: z.array(z.string().min(1).max(1024)).min(1).max(10),
            roots: z.array(z.string().min(1).max(1024)).max(2).optional(),
          }),
          z.object({
            kind: z.enum(["fill", "type"]),
            ref: z.string().min(1).max(200),
            text: z.string().max(32_000),
            origin: z.string().url().max(2048).optional(),
          }),
        ]),
      )
      .min(1)
      .max(24),
  }),
]);

function inputAction(input: z.infer<typeof inputSchema>["input"]): ComputerAction {
  if (input.kind === "key")
    return { kind: "key", key: input.key ?? "", modifiers: input.modifiers };
  if (input.kind === "clipboard") return { kind: "clipboard", text: input.text ?? "" };
  return {
    kind: "pointer",
    x: input.x ?? 0,
    y: input.y ?? 0,
    button: input.button,
    type: input.type ?? "click",
  };
}

function computerHome(header: string | undefined) {
  if (header === undefined) return undefined;
  try {
    const home = decodeURIComponent(header);
    return path.isAbsolute(home) ? home : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const screenModeSchema = z
  .object({
    interactive: z.boolean(),
    controlToken: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .optional(),
    revokeControl: z.boolean().optional(),
  })
  .refine((value) => !value.interactive || value.controlToken, {
    message: "interactive screen requires a control token",
  });

export function screenUrlWithToken(screenUrl: string, token: string) {
  const url = new URL(screenUrl);
  url.searchParams.set("path", `websockify?token=${encodeURIComponent(token)}`);
  return url.toString();
}

export function screenKey(c: Context, computerId: string) {
  return c.req.header("x-rakazo-screen-id") || c.req.header("x-rakazo-bot-id") || computerId;
}

export function createApi(service: ScreenService, supervisorToken: string) {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));
  app.use("/computers/*", async (c, next) => {
    if (!hasValidBearerToken(c.req.header("authorization"), supervisorToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
  app.use(
    "/computers/*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => c.json({ error: "Request body is too large." }, 413),
    }),
  );

  app.get("/computers/:id", (c) => c.json({ id: c.req.param("id"), running: true }));

  app.post("/computers/:id/screen-mode", async (c) => {
    const parsed = screenModeSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "invalid screen mode request" }, 400);
    const body = parsed.data;
    const key = screenKey(c, c.req.param("id"));
    try {
      if (body.interactive) {
        const record = await service.openScreen(key);
        if (record.controlToken && record.controlToken !== body.controlToken) {
          await service.revokeControl(record);
        }
        service.registry.setControl(key, body.controlToken);
        return c.json({ screenUrl: screenUrlWithToken(service.viewerUrl, body.controlToken!) });
      }
      const record = service.registry.get(key);
      if (body.revokeControl !== false) {
        if (record?.controlToken) await service.revokeControl(record);
        return c.json(
          record
            ? {
                screenUrl: screenUrlWithToken(service.viewerUrl, record.viewToken),
                asleep: service.asleep(key),
              }
            : {},
        );
      }
      if (!record) return c.json({ error: "screen is not allocated" }, 404);
      return c.json({
        screenUrl: screenUrlWithToken(service.viewerUrl, record.viewToken),
        asleep: service.asleep(key),
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post("/computers/:id/observe", async (c) => {
    try {
      return c.json(await service.observe(screenKey(c, c.req.param("id"))));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 500);
    }
  });

  app.post("/computers/:id/actions", async (c) => {
    const parsed = actionsSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "invalid computer actions" }, 400);
    const body = parsed.data;
    const key = screenKey(c, c.req.param("id"));
    try {
      const completed = await service.act(key, body.actions);
      if (body.observe === false) return c.json({ completed });
      if (body.settleMs) await new Promise((resolve) => setTimeout(resolve, body.settleMs));
      return c.json({ completed, observation: await service.observe(key) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 500);
    }
  });

  app.post("/computers/:id/browser", async (c) => {
    const parsed = browserSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "invalid browser command" }, 400);
    const body = parsed.data;
    const home = computerHome(c.req.header("x-rakazo-computer-home"));
    if (home === null) return c.json({ error: "invalid computer home" }, 400);
    try {
      return c.json(
        await service.browser(screenKey(c, c.req.param("id")), body, c.req.raw.signal, home),
      );
    } catch (error) {
      const detail = errorMessage(error);
      return c.json({
        ok: false,
        fallback: "computer_act",
        uncertain: body.command === "act",
        error:
          detail && detail !== "Page browser unavailable or interrupted"
            ? detail
            : "Page browser unavailable or interrupted. Inspect the screen before continuing.",
      });
    }
  });

  app.post("/computers/:id/input", async (c) => {
    const parsed = inputSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ ok: false, error: "invalid computer input" }, 400);
    try {
      await service.act(screenKey(c, c.req.param("id")), [inputAction(parsed.data.input)]);
      return c.json({ ok: true, leaseId: parsed.data.leaseId ?? null });
    } catch (error) {
      return c.json({ ok: false, error: errorMessage(error) }, 500);
    }
  });

  app.post("/computers/:id/screen/wake", async (c) => {
    const key = screenKey(c, c.req.param("id"));
    if (!service.registry.get(key)) return c.json({ error: "screen is not allocated" }, 404);
    try {
      await service.wake(key);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 500);
    }
  });

  app.post("/computers/:id/screen/reset", async (c) => {
    try {
      await service.reset(screenKey(c, c.req.param("id")));
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 500);
    }
  });

  app.get("/computers/:id/screen", (c) => {
    const record = service.registry.get(screenKey(c, c.req.param("id")));
    if (!record) return c.json({ error: "computer not found" }, 404);
    return c.redirect(screenUrlWithToken(service.viewerUrl, record.viewToken));
  });

  app.delete("/computers/:id/screen", async (c) => {
    const record = service.registry.get(screenKey(c, c.req.param("id")));
    try {
      if (record?.controlToken) await service.revokeControl(record);
      return c.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message || "computer screen failed to stop" }, 500);
    }
  });

  return app;
}

import { hasValidBearerToken } from "@rakazo/core";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { ScreenRecord, ScreenRegistry } from "./screens.js";

export interface ScreenService {
  registry: ScreenRegistry;
  viewerUrl: string;
  openScreen(key: string): Promise<ScreenRecord>;
  revokeControl(record: ScreenRecord): Promise<void>;
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
          record ? { screenUrl: screenUrlWithToken(service.viewerUrl, record.viewToken) } : {},
        );
      }
      if (!record) return c.json({ error: "screen is not allocated" }, 404);
      return c.json({ screenUrl: screenUrlWithToken(service.viewerUrl, record.viewToken) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
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

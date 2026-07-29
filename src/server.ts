import { Hono } from "hono";
import type { StepInvocation } from "@lwmacct/260729-ba-context-baton";
import type { CatalogExecutor } from "./executor.js";

export const API_PREFIX = "/api";
export type ExecutorServerOptions = {
  executor: CatalogExecutor;
  token?: string;
};

function bearerToken(value: string | undefined) {
  return value?.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createExecutorServer(options: ExecutorServerOptions) {
  const token = options.token?.trim() ?? "";
  const app = new Hono();

  app.use("*", async (context, next) => {
    context.header("Access-Control-Allow-Origin", "*");
    context.header("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type");
    context.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    context.header("Access-Control-Max-Age", "86400");
    if (context.req.method === "OPTIONS") return context.body(null, 204);
    await next();
  });

  app.get(`${API_PREFIX}/health`, (context) => context.json({
    ok: true,
    packs: options.executor.packs.map((pack) => pack.id),
  }));

  app.use(`${API_PREFIX}/*`, async (context, next) => {
    if (context.req.path === `${API_PREFIX}/health` || !token) {
      await next();
      return;
    }
    if (bearerToken(context.req.header("authorization")) !== token) {
      return context.json({ ok: false, error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get(`${API_PREFIX}/auth/verify`, (context) => context.json({ valid: true }));
  app.get(`${API_PREFIX}/manifest`, (context) => context.json(options.executor.manifest));
  app.post(`${API_PREFIX}/steps/execute`, async (context) => {
    try {
      const invocation = await context.req.json<StepInvocation>();
      return context.json(await options.executor.execute(invocation, context.req.raw.signal));
    } catch (error) {
      return context.json({ ok: false, error: errorMessage(error) }, 400);
    }
  });
  app.all(`${API_PREFIX}/*`, (context) => context.json({ ok: false, error: "not found" }, 404));
  return app;
}

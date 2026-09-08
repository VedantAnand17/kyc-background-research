// HTTP routes. PRD.md section 5.
// M1 ships GET /health and the OpenAPI document. M6 adds POST /research.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Config } from "../config.js";
import type { Db } from "../db/sqlite.js";
import type { Logger } from "../logger.js";
import pkg from "../../package.json" with { type: "json" };

export interface AppDeps {
  readonly config: Config;
  readonly db: Db;
  readonly log: Logger;
}

const HealthResponse = z.object({ status: z.literal("ok"), version: z.string() }).openapi("Health");

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  responses: {
    200: { description: "Service is up", content: { "application/json": { schema: HealthResponse } } },
  },
});

export function createApp(_deps: AppDeps) {
  const app = new OpenAPIHono();

  app.openapi(healthRoute, (c) => c.json({ status: "ok" as const, version: pkg.version }, 200));

  // TODO(M6): POST /research per PRD.md 5.1, using schemas from ./schemas.ts and the orchestrator.

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Background research API", version: pkg.version },
  });

  return app;
}

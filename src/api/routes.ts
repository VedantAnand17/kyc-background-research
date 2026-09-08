// HTTP routes. PRD.md section 5.
// GET /health and /openapi.json ship from M1. M6 adds POST /research and GET /docs.
import { join } from "node:path";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Config } from "../config.js";
import type { Db } from "../db/sqlite.js";
import type { Logger } from "../logger.js";
import { createFixturePerfloClient, createPerfloClient, type PerfloClient } from "../perflo/client.js";
import { createAgent, type ResearchAgent } from "../research/agent.js";
import { ResearchUnavailableError, runResearch } from "../research/orchestrator.js";
import {
  ReportInvariantError,
  ReportSchema,
  ResearchRequestSchema,
  UnavailableErrorSchema,
  ValidationErrorSchema,
} from "./schemas.js";
import pkg from "../../package.json" with { type: "json" };

export interface AppDeps {
  readonly config: Config;
  readonly db: Db;
  readonly log: Logger;
  readonly client?: PerfloClient;
  readonly agent?: ResearchAgent;
}

const HealthResponse = z.object({ status: z.literal("ok"), version: z.string() }).openapi("Health");

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  responses: {
    200: { description: "Service is up", content: { "application/json": { schema: HealthResponse } } },
  },
});

const researchRoute = createRoute({
  method: "post",
  path: "/research",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: ResearchRequestSchema } },
    },
  },
  responses: {
    200: { description: "Costed research report", content: { "application/json": { schema: ReportSchema } } },
    400: { description: "Request failed validation", content: { "application/json": { schema: ValidationErrorSchema } } },
    503: {
      description: "No lookup could be attempted",
      content: { "application/json": { schema: UnavailableErrorSchema } },
    },
  },
});

function resolveClient(deps: AppDeps): PerfloClient {
  if (deps.client) return deps.client;
  if (deps.config.FIXTURE_MODE) {
    return createFixturePerfloClient(join(process.cwd(), "test/fixtures"));
  }
  if (!deps.config.PERFLO_AGENT_KEY) {
    throw new Error("PERFLO_AGENT_KEY is required unless FIXTURE_MODE=true");
  }
  return createPerfloClient({
    baseUrl: deps.config.PERFLO_BASE_URL,
    agentKey: deps.config.PERFLO_AGENT_KEY,
    timeoutMs: deps.config.VENDOR_TIMEOUT_MS,
  });
}

const DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Background research API</title>
</head>
<body>
  <script id="api-reference" data-url="/openapi.json"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;

export function createApp(deps: AppDeps) {
  const client = resolveClient(deps);
  const agent = deps.agent ?? createAgent(deps.config);
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error" as const, issues: result.error.issues }, 400);
      }
    },
  });

  app.openapi(healthRoute, (c) => c.json({ status: "ok" as const, version: pkg.version }, 200));

  app.openapi(researchRoute, async (c) => {
    const body = c.req.valid("json");
    try {
      const configuredDeadline =
        process.env.RESEARCH_DEADLINE_MS !== undefined ? deps.config.RESEARCH_DEADLINE_MS : undefined;
      const report = await runResearch(body, {
        db: deps.db,
        log: deps.log,
        client,
        agent,
        concurrency: deps.config.TOOL_CONCURRENCY,
        ...(configuredDeadline !== undefined ? { deadlineMs: configuredDeadline } : {}),
      });
      return c.json(report, 200);
    } catch (err) {
      if (err instanceof ResearchUnavailableError) {
        return c.json({ error: "unavailable" as const, code: err.code, message: err.message }, 503);
      }
      if (err instanceof ReportInvariantError) {
        deps.log.error({ err }, "report schema validation failure");
      }
      throw err;
    }
  });

  app.get("/docs", (c) => c.html(DOCS_HTML));

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Background research API", version: pkg.version },
  });

  return app;
}

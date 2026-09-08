import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../src/api/routes.js";
import { ReportSchema } from "../src/api/schemas.js";
import { loadConfig } from "../src/config.js";
import { openDatabase, type Db } from "../src/db/sqlite.js";
import { createLogger } from "../src/logger.js";
import { createScriptedAgent } from "./scripted-agent.js";
import { researchRequest } from "./research-harness.js";

const FIXTURE_MARKER = resolve("test/fixtures/vendors/stableenrich-minerva-resolve.contract.json");
const fixturesReady = existsSync(FIXTURE_MARKER);

const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs) db.close();
  dbs.length = 0;
});

describe("fixture-mode boot", () => {
  it.skipIf(!fixturesReady)("POST /research with FIXTURE_MODE=true makes no network calls", async () => {
    const db = openDatabase(":memory:");
    dbs.push(db);
    const originalFetch = globalThis.fetch;
    const fetchCalls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      fetchCalls.push(String(input));
      throw new Error(`network forbidden in fixture mode: ${String(input)}`);
    }) as typeof fetch;
    try {
      const app = createApp({
        config: loadConfig({
          FIXTURE_MODE: "true",
          LLM_API_KEY: "unused",
          LLM_PROVIDER: "openai-compatible",
          LLM_BASE_URL: "http://127.0.0.1:9",
          LOG_LEVEL: "error",
        }),
        db,
        log: createLogger("silent"),
        agent: createScriptedAgent(),
      });
      const res = await app.request("/research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(researchRequest("1.50")),
      });
      expect(res.status).toBe(200);
      ReportSchema.parse(await res.json());
      expect(fetchCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

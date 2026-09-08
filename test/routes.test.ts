import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/api/routes.js";
import { ReportSchema, ResearchRequestSchema } from "../src/api/schemas.js";
import { loadConfig } from "../src/config.js";
import { openDatabase, type Db } from "../src/db/sqlite.js";
import { createLogger } from "../src/logger.js";
import { createPerfloClient } from "../src/perflo/client.js";
import { PerfloError } from "../src/perflo/errors.js";
import { startFakePerflo, type FakePerflo } from "./fake-perflo.js";
import { createScriptedAgent } from "./scripted-agent.js";

const dbs: Db[] = [];
const fakes: FakePerflo[] = [];

afterEach(async () => {
  for (const db of dbs) db.close();
  dbs.length = 0;
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

function config() {
  return loadConfig({
    FIXTURE_MODE: "true",
    LLM_API_KEY: "test",
    LLM_PROVIDER: "openai-compatible",
    LLM_BASE_URL: "http://127.0.0.1:9",
    LOG_LEVEL: "error",
  });
}

const ADA = {
  firstName: "Ada",
  lastName: "Okonkwo",
  dateOfBirth: "1991-04-12",
  address: { city: "Lagos", country: "NG" },
  maxBudget: { amount: "1.50", currency: "USD" },
};

async function appWithFake() {
  const server = await startFakePerflo();
  fakes.push(server);
  server.setPayOutput("stableenrich-minerva-resolve", {
    people: [
      { name: "Ada Okonkwo", dateOfBirth: "1991-04-12", city: "Lagos", country: "NG", company: "Paystack" },
    ],
  });
  server.setSearchResults("PEP sanctions watchlist screening", []);
  server.setSearchResults("web search", []);
  const db = openDatabase(":memory:");
  dbs.push(db);
  const app = createApp({
    config: config(),
    db,
    log: createLogger("silent"),
    client: createPerfloClient({ baseUrl: server.baseUrl, agentKey: "perflo_test_fake", timeoutMs: 2_000 }),
    agent: createScriptedAgent(),
  });
  return { app, server };
}

describe("POST /research", () => {
  it("returns a schema-valid report in fixture mode", async () => {
    const { app } = await appWithFake();
    const res = await app.request("/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ADA),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const report = ReportSchema.parse(body);
    expect(report.identity.status).toBe("confirmed");
    expect(report.costs.total.amount).toMatch(/^\d+\.\d{6}$/);
    expect(report.tier).toBe("standard");
  });

  it("rejects an unknown field with 400", async () => {
    const { app } = await appWithFake();
    const res = await app.request("/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...ADA, extra: true }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_error");
  });

  it("rejects a zero cap and a future date of birth", () => {
    expect(() => ResearchRequestSchema.parse({ ...ADA, maxBudget: { amount: "0", currency: "USD" } })).toThrow();
    expect(() => ResearchRequestSchema.parse({ ...ADA, dateOfBirth: "2999-01-01" })).toThrow();
  });

  it("returns 503 when Perflo cannot be reached before the first lookup", async () => {
    const db = openDatabase(":memory:");
    dbs.push(db);
    const app = createApp({
      config: config(),
      db,
      log: createLogger("silent"),
      client: {
        getVendor: async () => {
          throw new Error("unused");
        },
        search: async () => {
          throw new Error("unused");
        },
        pay: async () => {
          throw new Error("unused");
        },
        getTransaction: async () => {
          throw new Error("unused");
        },
        listTransactions: async () => {
          throw new Error("unused");
        },
        getBalance: async () => {
          throw new PerfloError("NETWORK_ERROR", "Could not reach Perflo.", 0, undefined, undefined);
        },
      },
      agent: createScriptedAgent(),
    });
    const res = await app.request("/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ADA),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe("unavailable");
    expect(body.code).toBe("NETWORK_ERROR");
  });
});

describe("GET /docs", () => {
  it("renders an OpenAPI explorer that points at /openapi.json", async () => {
    const { app } = await appWithFake();
    const docs = await app.request("/docs");
    expect(docs.status).toBe(200);
    expect(docs.headers.get("content-type") ?? "").toMatch(/text\/html/);
    const html = await docs.text();
    expect(html).toContain("/openapi.json");
    const spec = await app.request("/openapi.json");
    expect(spec.status).toBe(200);
    const body = (await spec.json()) as { paths: Record<string, unknown> };
    expect(body.paths["/research"]).toBeTruthy();
    expect(body.paths["/health"]).toBeTruthy();
  });
});

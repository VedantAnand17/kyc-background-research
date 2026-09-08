import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { parseMoney } from "../src/budget/money.js";
import { createApp } from "../src/api/routes.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createAgent } from "../src/research/agent.js";
import { runResearch } from "../src/research/orchestrator.js";
import { createScriptedAgent } from "./scripted-agent.js";
import {
  expectValidCosts,
  researchRequest,
  startResearchHarness,
  warningCodes,
} from "./research-harness.js";

const dbs: Array<{ close: () => void }> = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const db of dbs) db.close();
  dbs.length = 0;
  await Promise.all(closers.splice(0).map((fn) => fn()));
});

async function startFakeLlm(status: number, hangMs = 0): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = new Hono();
  app.post("/chat/completions", async (c) => {
    if (hangMs > 0) await new Promise((resolve) => setTimeout(resolve, hangMs));
    return c.json({ error: { message: "unauthorized" } }, status as 401);
  });
  const server = createServer(getRequestListener(app.fetch));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("fake llm failed to bind");
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe("failure injection end to end", () => {
  it("returns 503 llm_unavailable when the model rejects auth before the first lookup", async () => {
    const llm = await startFakeLlm(401);
    closers.push(llm.close);
    const { server, db, deps } = await startResearchHarness();
    dbs.push(db);
    closers.push(() => server.close());
    const config = loadConfig({
      FIXTURE_MODE: "true",
      LLM_PROVIDER: "openai-compatible",
      LLM_BASE_URL: llm.baseUrl,
      LLM_API_KEY: "bad-key",
      LLM_MODEL: "test-model",
      LOG_LEVEL: "error",
    });
    const app = createApp({
      config,
      db,
      log: createLogger("silent"),
      client: deps.client,
      agent: createAgent(config),
    });
    const res = await app.request("/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(researchRequest("0.40")),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe("unavailable");
    expect(body.code).toBe("llm_unavailable");
  });

  it("returns a report with llm_unavailable when the model times out after a lookup", async () => {
    const { server, db, deps } = await startResearchHarness();
    dbs.push(db);
    closers.push(() => server.close());
    const agent = createScriptedAgent();
    const report = await runResearch(researchRequest("0.40"), {
      ...deps,
      agent: {
        ...agent,
        narrate: async () => {
          throw new Error("model timeout");
        },
      },
    });
    expect(report.identity.status).toBe("confirmed");
    expect(warningCodes(report)).toEqual(expect.arrayContaining(["llm_unavailable", "narrative_unavailable"]));
    expect(report.risk.overall.rationale).toBe("narrative unavailable");
    expectValidCosts(report, "0.40");
  });

  it("returns 503 NETWORK_ERROR when Perflo is unreachable before the first lookup", async () => {
    const { db } = await startResearchHarness();
    dbs.push(db);
    const app = createApp({
      config: loadConfig({
        FIXTURE_MODE: "true",
        LLM_API_KEY: "test",
        LLM_PROVIDER: "openai-compatible",
        LLM_BASE_URL: "http://127.0.0.1:9",
        LOG_LEVEL: "error",
      }),
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
        getTask: async () => {
          throw new Error("unused");
        },
        getKey: async () => {
          const { PerfloError } = await import("../src/perflo/errors.js");
          throw new PerfloError("NETWORK_ERROR", "Could not reach Perflo.", 0, undefined, undefined);
        },
      },
      agent: createScriptedAgent(),
    });
    const res = await app.request("/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(researchRequest("0.40")),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe("unavailable");
    expect(body.code).toBe("NETWORK_ERROR");
  });

  it("settles a vendor 200 failed charge and surfaces vendor_failed", async () => {
    const { server, db, deps } = await startResearchHarness();
    dbs.push(db);
    closers.push(() => server.close());
    server.setScenario("apify-anchor-linkedin-profile-enrichment", "failed");
    const report = await runResearch(researchRequest("1.50"), deps);
    expect(warningCodes(report)).toContain("vendor_failed");
    const failed = report.costs.calls.filter((row) => row.capability === "enrich_person");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((row) => row.status === "failed")).toBe(true);
    expect(failed.every((row) => parseMoney(row.charged.amount) > 0n)).toBe(true);
    expectValidCosts(report, "1.50");
  });

  it("holds a vendor timeout then reconciles it from the transaction list", async () => {
    const { server, db, deps } = await startResearchHarness({ timeoutMs: 250 });
    dbs.push(db);
    closers.push(() => server.close());
    server.setScenario("apify-anchor-linkedin-profile-enrichment", "hang");
    const report = await runResearch(researchRequest("1.50"), deps);
    expect(warningCodes(report)).toContain("TIMEOUT");
    const held = db
      .prepare(`SELECT state FROM ledger WHERE vendor = ?`)
      .all("apify-anchor-linkedin-profile-enrichment") as Array<{ state: string }>;
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((row) => row.state === "settled" || row.state === "released")).toBe(true);
    expect(held.some((row) => row.state === "settled")).toBe(true);
    expectValidCosts(report, "1.50");
  });

  it("polls a 202 running vendor task to its result instead of treating it as confirm-first", async () => {
    const { server, db, deps } = await startResearchHarness();
    dbs.push(db);
    closers.push(() => server.close());
    server.setScenario("apify-anchor-linkedin-profile-enrichment", "running");
    const report = await runResearch(researchRequest("1.50"), deps);
    expect(warningCodes(report)).not.toContain("CONFIRMATION_REQUIRED");
    expect(server.taskReads.length).toBeGreaterThanOrEqual(2);
    const enrich = report.costs.calls.filter((row) => row.capability === "enrich_person");
    expect(enrich).toHaveLength(1);
    expect(enrich[0]!.status).toBe("succeeded");
    expect(enrich[0]!.transactionId).toMatch(/^tx-run_res_/);
    expect(parseMoney(enrich[0]!.charged.amount)).toBeGreaterThan(0n);
    expectValidCosts(report, "1.50");
  });

  it("holds a task still running at the vendor timeout, then settles it from the outcome recorded before the report", async () => {
    const { server, db, deps } = await startResearchHarness({ timeoutMs: 300 });
    dbs.push(db);
    closers.push(() => server.close());
    server.setScenario("apify-anchor-linkedin-profile-enrichment", "running-forever");
    // Only reconciliation calls getTask; the pay poll loop reads poll.url directly. Finishing the task
    // there models a vendor that completed after our timeout but before the report was assembled.
    const client = {
      ...deps.client,
      getTask: (runId: string) => {
        server.finishTask(runId);
        return deps.client.getTask(runId);
      },
    };
    const report = await runResearch(researchRequest("1.50"), { ...deps, client });
    expect(warningCodes(report)).toContain("TIMEOUT");
    const enrich = report.costs.calls.filter((row) => row.capability === "enrich_person");
    expect(enrich).toHaveLength(1);
    expect(enrich[0]!.transactionId).toMatch(/^tx-run_res_/);
    expect(parseMoney(enrich[0]!.charged.amount)).toBe(parseMoney("0.025200"));
    expectValidCosts(report, "1.50");
  });

  it("settles a task still running at report time at its reserved quote so a late charge cannot breach the cap", async () => {
    const { server, db, deps } = await startResearchHarness({ timeoutMs: 300 });
    dbs.push(db);
    closers.push(() => server.close());
    server.setScenario("apify-anchor-linkedin-profile-enrichment", "running-forever");
    const report = await runResearch(researchRequest("1.50"), deps);
    expect(warningCodes(report)).toContain("TIMEOUT");
    const enrich = report.costs.calls.filter((row) => row.capability === "enrich_person");
    expect(enrich).toHaveLength(1);
    expect(enrich[0]!.transactionId).toMatch(/^run_res_/);
    const row = db
      .prepare(`SELECT state, reserved_micro, charged_micro FROM ledger WHERE vendor = ?`)
      .get("apify-anchor-linkedin-profile-enrichment") as { state: string; reserved_micro: string; charged_micro: string };
    expect(row.state).toBe("settled");
    expect(row.charged_micro).toBe(row.reserved_micro);
    expectValidCosts(report, "1.50");
  });

  it("stops spending on GUARDRAIL_DENIED and names that code in warnings", async () => {
    const { server, db, deps } = await startResearchHarness();
    dbs.push(db);
    closers.push(() => server.close());
    server.setScenario("apify-anchor-linkedin-profile-enrichment", "GUARDRAIL_DENIED");
    const paysBefore = server.payCalls.length;
    const report = await runResearch(researchRequest("1.50"), deps);
    expect(warningCodes(report)).toContain("GUARDRAIL_DENIED");
    const enrichPays = server.payCalls
      .slice(paysBefore)
      .filter((row) => row.slug === "apify-anchor-linkedin-profile-enrichment");
    expect(enrichPays.length).toBeGreaterThan(0);
    const enrichCalls = report.costs.calls.filter((row) => row.capability === "enrich_person");
    expect(enrichCalls.every((row) => parseMoney(row.charged.amount) === 0n)).toBe(true);
    expectValidCosts(report, "1.50");
  });
});

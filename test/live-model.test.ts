// Real glm-5.3 against the in-process fake Perflo server. Skipped without Workers AI credentials.
// This is the test that would have caught empty narrative, double-pay, deadline padding, and Houston leakage.
import { afterEach, describe, expect, it } from "vitest";
import { parseMoney } from "../src/budget/money.js";
import { loadConfig } from "../src/config.js";
import { createAgent } from "../src/research/agent.js";
import { CAPABILITIES } from "../src/research/capabilities.js";
import { runResearch } from "../src/research/orchestrator.js";
import { LIVE_PHASE_TARGETS_MS, liveLlmCredentials } from "./live-env.js";
import {
  expectValidCosts,
  houstonAttachedToPrimary,
  researchRequest,
  startResearchHarness,
} from "./research-harness.js";

const creds = liveLlmCredentials();
const dbs: Array<{ close: () => void }> = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const db of dbs) db.close();
  dbs.length = 0;
  await Promise.all(closers.splice(0).map((fn) => fn()));
});

const PERSON_TOOLS = new Set([
  "find_people",
  "enrich_person",
  "skip_trace",
  "screen_watchlist",
  "search_filings",
  "get_professional_profile",
]);

const CASES = [
  { amount: "0.40", tier: "basic" as const },
  { amount: "1.50", tier: "standard" as const },
  { amount: "3.00", tier: "deep" as const },
];

describe.skipIf(!creds)("live glm-5.3 against fake Perflo", () => {
  it.each(CASES)(
    "$tier: narrative present, under cap, Houston excluded, person-tools paid once",
    async ({ amount, tier }) => {
      if (!creds) return;
      const { server, db, deps } = await startResearchHarness();
      dbs.push(db);
      closers.push(() => server.close());
      const config = loadConfig({
        FIXTURE_MODE: "true",
        LLM_PROVIDER: "cloudflare",
        CLOUDFLARE_ACCOUNT_ID: creds.accountId,
        LLM_API_KEY: creds.apiKey,
        LLM_MODEL: "@cf/zai-org/glm-5.3",
        LOG_LEVEL: "error",
      });
      const report = await runResearch(researchRequest(amount), {
        ...deps,
        agent: createAgent(config),
      });

      expect(report.tier).toBe(tier);
      expect(report.timing.deadlineHit).toBe(false);
      expect(report.risk.overall.rationale).not.toBe("narrative unavailable");
      expect(report.risk.overall.rationale.trim().length).toBeGreaterThan(0);
      expect(report.warnings.some((w) => w.code === "narrative_unavailable")).toBe(false);
      expect(houstonAttachedToPrimary(report)).toBe(false);
      expectValidCosts(report, amount);

      // Count settled pays by tool from the report: find_people and search_web share the Exa slug, so
      // attributing server.payCalls by slug would count a web search as a second find_people.
      expect(report.costs.calls.length).toBe(server.payCalls.length);
      const paysByTool = new Map<string, number>();
      for (const call of report.costs.calls) {
        if (!PERSON_TOOLS.has(call.capability)) continue;
        paysByTool.set(call.capability, (paysByTool.get(call.capability) ?? 0) + 1);
      }
      for (const [tool, count] of paysByTool) {
        expect(count, tool).toBe(1);
      }

      const phases = report.timing.phases;
      if (phases.resolve !== undefined) expect(phases.resolve).toBeLessThan(LIVE_PHASE_TARGETS_MS.resolve);
      if (phases.enrich !== undefined) expect(phases.enrich).toBeLessThan(LIVE_PHASE_TARGETS_MS.enrich);
      if (phases.screen !== undefined) expect(phases.screen).toBeLessThan(LIVE_PHASE_TARGETS_MS.screen);
      if (phases.report !== undefined) expect(phases.report).toBeLessThan(LIVE_PHASE_TARGETS_MS.report);
      expect(report.timing.totalMs).toBeLessThan(LIVE_PHASE_TARGETS_MS[tier]);
      expect(parseMoney(report.costs.total.amount)).toBeLessThanOrEqual(parseMoney(amount));
    },
    120_000,
  );
});

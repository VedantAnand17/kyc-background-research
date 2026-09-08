// Five live glm-5.3 runs per tier against the fake Perflo server.
// Prints p50 per phase. Raise RESEARCH_DEADLINE_MS only from this evidence.
import { loadConfig } from "../src/config.js";
import { createAgent } from "../src/research/agent.js";
import { runResearch } from "../src/research/orchestrator.js";
import { LIVE_PHASE_TARGETS_MS, liveLlmCredentials } from "../test/live-env.js";
import { researchRequest, startResearchHarness } from "../test/research-harness.js";

const RUNS = 5;
const TIERS = [
  { amount: "0.40", name: "basic" as const },
  { amount: "1.50", name: "standard" as const },
  { amount: "3.00", name: "deep" as const },
];

function p50(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor((sorted.length - 1) / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return Math.round(((sorted[mid] ?? 0) + (sorted[mid + 1] ?? 0)) / 2);
}

const creds = liveLlmCredentials();
if (!creds) {
  console.log("skip: set LLM_API_KEY and CLOUDFLARE_ACCOUNT_ID to sample live performance");
  process.exit(0);
}

const config = loadConfig({
  FIXTURE_MODE: "true",
  LLM_PROVIDER: "cloudflare",
  CLOUDFLARE_ACCOUNT_ID: creds.accountId,
  LLM_API_KEY: creds.apiKey,
  LLM_MODEL: "@cf/zai-org/glm-5.3",
  LOG_LEVEL: "error",
});

const rows: string[] = ["tier\tphase\tp50_ms\ttarget_ms\tok"];
for (const tier of TIERS) {
  const buckets: Record<string, number[]> = { total: [] };
  for (let i = 0; i < RUNS; i++) {
    const { server, db, deps } = await startResearchHarness();
    try {
      const report = await runResearch(researchRequest(tier.amount), {
        ...deps,
        agent: createAgent(config),
      });
      buckets.total.push(report.timing.totalMs);
      for (const [phase, ms] of Object.entries(report.timing.phases)) {
        (buckets[phase] ??= []).push(ms);
      }
      console.error(`${tier.name} run ${i + 1}/${RUNS} total=${report.timing.totalMs}ms deadlineHit=${report.timing.deadlineHit}`);
    } finally {
      db.close();
      await server.close();
    }
  }
  for (const [phase, values] of Object.entries(buckets)) {
    const target =
      phase === "total"
        ? LIVE_PHASE_TARGETS_MS[tier.name]
        : LIVE_PHASE_TARGETS_MS[phase as keyof typeof LIVE_PHASE_TARGETS_MS] ?? 45_000;
    const median = p50(values);
    rows.push(`${tier.name}\t${phase}\t${median}\t${target}\t${median < target ? "yes" : "NO"}`);
  }
}
console.log(rows.join("\n"));

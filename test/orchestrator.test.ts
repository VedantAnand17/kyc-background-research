import { afterEach, describe, expect, it } from "vitest";
import { parseMoney } from "../src/budget/money.js";
import { openDatabase, type Db } from "../src/db/sqlite.js";
import { createLogger } from "../src/logger.js";
import { createPerfloClient } from "../src/perflo/client.js";
import type { ResearchRequest } from "../src/api/schemas.js";
import { runResearch } from "../src/research/orchestrator.js";
import { startFakePerflo, type FakePerflo } from "./fake-perflo.js";
import { createScriptedAgent } from "./scripted-agent.js";

const dbs: Db[] = [];
const fakes: FakePerflo[] = [];

afterEach(async () => {
  for (const db of dbs) db.close();
  dbs.length = 0;
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

const ADA: Omit<ResearchRequest, "maxBudget" | "options"> = {
  firstName: "Ada",
  lastName: "Okonkwo",
  dateOfBirth: "1991-04-12",
  address: { city: "Lagos", region: "Lagos", country: "NG" },
};

function request(amount: string, deadlineMs?: number): ResearchRequest {
  return {
    ...ADA,
    maxBudget: { amount, currency: "USD" },
    ...(deadlineMs ? { options: { deadlineMs } } : {}),
  };
}

const CONFIRMED = {
  people: [
    {
      name: "Ada Okonkwo",
      dateOfBirth: "1991-04-12",
      city: "Lagos",
      country: "NG",
      company: "Paystack",
    },
  ],
};

const AMBIGUOUS = {
  people: [
    { name: "Ada Okonkwo", dateOfBirth: "1991-04-12" },
    { name: "Ada Okonkwo", dateOfBirth: "1991-04-12" },
  ],
};

async function harness() {
  const server = await startFakePerflo();
  fakes.push(server);
  server.setPayOutput("stableenrich-minerva-resolve", CONFIRMED);
  server.setSearchResults("PEP sanctions watchlist screening", []);
  server.setSearchResults("web search", []);
  const db = openDatabase(":memory:");
  dbs.push(db);
  return {
    server,
    db,
    deps: {
      db,
      log: createLogger("silent"),
      client: createPerfloClient({ baseUrl: server.baseUrl, agentKey: "perflo_test_fake", timeoutMs: 2_000 }),
      agent: createScriptedAgent(),
    },
  };
}

function expectValidCosts(report: Awaited<ReturnType<typeof runResearch>>, cap: string) {
  const total = parseMoney(report.costs.total.amount);
  const budget = parseMoney(report.costs.budget.amount);
  const remaining = parseMoney(report.costs.remaining.amount);
  const sum = report.costs.calls.reduce((acc, row) => acc + parseMoney(row.charged.amount), 0n);
  expect(report.costs.budget.amount).toBe(parseMoney(cap) === budget ? report.costs.budget.amount : cap);
  expect(budget).toBe(parseMoney(cap));
  expect(total).toBe(sum);
  expect(total).toBeLessThanOrEqual(budget);
  expect(remaining).toBe(budget - total);
  expect(report.costs.total.amount).toMatch(/^\d+\.\d{6}$/);
}

describe("orchestrator (fixture mode)", () => {
  it("basic tier request produces a valid report under the cap", async () => {
    const { deps, db } = await harness();
    const report = await runResearch(request("0.40"), deps);
    expect(report.tier).toBe("basic");
    expect(report.identity.status).toBe("confirmed");
    expect(report.identity.primaryCandidateId).toBe("c1");
    expect(report.risk.pep.status).toBe("not_screened");
    expect(report.risk.sanctions.status).toBe("not_screened");
    expect(report.timing.deadlineHit).toBe(false);
    expectValidCosts(report, "0.40");
    const job = db.prepare(`SELECT spent_micro, status FROM jobs WHERE id = ?`).get(report.requestId) as {
      spent_micro: string;
      status: string;
    };
    expect(job.status).toBe("succeeded");
    expect(BigInt(job.spent_micro)).toBe(parseMoney(report.costs.total.amount));
  });

  it("standard tier request produces a valid report under the cap", async () => {
    const { deps } = await harness();
    const report = await runResearch(request("1.50"), deps);
    expect(report.tier).toBe("standard");
    expect(report.identity.status).toBe("confirmed");
    expect(report.sources.some((s) => s.capability === "enrich_person" || s.capability === "get_professional_profile")).toBe(
      true,
    );
    expectValidCosts(report, "1.50");
  });

  it("deep tier request produces a valid report under the cap", async () => {
    const { deps } = await harness();
    const report = await runResearch(request("3.00"), deps);
    expect(report.tier).toBe("deep");
    expect(report.identity.status).toBe("confirmed");
    expect(report.sources.some((s) => s.capability === "search_filings")).toBe(true);
    expectValidCosts(report, "3.00");
  });

  it("deadline hit cuts phases and still produces a report with timing.deadlineHit", async () => {
    const { deps } = await harness();
    const report = await runResearch(request("1.50", 5_000), { ...deps, now: 0 });
    expect(report.timing.deadlineHit).toBe(true);
    expect(report.warnings.some((w) => w.code === "deadline_hit")).toBe(true);
    expect(report.costs.total.amount).toMatch(/^\d+\.\d{6}$/);
    expect(parseMoney(report.costs.total.amount)).toBeLessThanOrEqual(parseMoney("1.50"));
    expect(report.risk.overall.rationale).not.toBe("narrative unavailable");
    expect(report.warnings.some((w) => w.code === "narrative_unavailable")).toBe(false);
  });

  it("a skipped screen marks every risk category not_screened and overall unknown", async () => {
    const { server, deps } = await harness();
    server.setPayOutput("stableenrich-minerva-resolve", { people: [] });
    const report = await runResearch(request("1.50"), deps);
    expect(report.identity.status).toBe("not_found");
    expect(report.risk.pep.status).toBe("not_screened");
    expect(report.risk.sanctions.status).toBe("not_screened");
    expect(report.risk.fraud.status).toBe("not_screened");
    expect(report.risk.reputational.status).toBe("not_screened");
    expect(report.risk.overall.level).toBe("unknown");
    expect(report.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining([
        "pep_not_screened",
        "sanctions_not_screened",
        "fraud_not_screened",
        "reputational_not_screened",
      ]),
    );
  });

  it("budget exhausted mid-enrich finishes with warnings and total <= cap", async () => {
    const { deps } = await harness();
    const report = await runResearch(request("0.03"), deps);
    expect(report.tier).toBe("basic");
    expect(report.identity.status).toBe("confirmed");
    expect(parseMoney(report.costs.total.amount)).toBeLessThanOrEqual(parseMoney("0.03"));
    expect(report.warnings.some((w) => w.code === "budget_exhausted" || w.code === "pep_not_screened")).toBe(true);
    expectValidCosts(report, "0.03");
  });

  it("ambiguous identity yields empty profile and overall risk unknown", async () => {
    const { server, deps } = await harness();
    server.setPayOutput("stableenrich-minerva-resolve", AMBIGUOUS);
    const report = await runResearch(request("0.40"), {
      ...deps,
      agent: createScriptedAgent({ disambiguate: "skip" }),
    });
    expect(report.identity.status).toBe("ambiguous");
    expect(report.identity.primaryCandidateId).toBeNull();
    expect(report.profile.employment).toEqual([]);
    expect(report.profile.news).toEqual([]);
    expect(report.risk.overall.level).toBe("unknown");
    expect(report.warnings.some((w) => w.code === "identity_ambiguous")).toBe(true);
    expectValidCosts(report, "0.40");
  });

  it("throws llm_unavailable when the model fails before the first lookup", async () => {
    const { deps } = await harness();
    const agent = createScriptedAgent();
    await expect(
      runResearch(request("0.40"), {
        ...deps,
        agent: {
          ...agent,
          resolve: async () => {
            throw new Error("model 401");
          },
        },
      }),
    ).rejects.toMatchObject({ name: "ResearchUnavailableError", code: "llm_unavailable" });
  });

  it("warns llm_unavailable and still reports when the model fails after a lookup", async () => {
    const { deps } = await harness();
    const agent = createScriptedAgent();
    const report = await runResearch(request("0.40"), {
      ...deps,
      agent: {
        ...agent,
        enrich: async () => {
          throw new Error("model timeout");
        },
      },
    });
    expect(report.identity.status).toBe("confirmed");
    expect(report.warnings.some((w) => w.code === "llm_unavailable" && w.message.includes("enrich"))).toBe(true);
    expectValidCosts(report, "0.40");
  });

  it("keeps unclassified news off the primary when classification fails", async () => {
    const { server, deps } = await harness();
    server.setPayOutput("ottoai-filtered-news", {
      articles: [
        { title: "Paystack names Ada Okonkwo product lead", url: "https://news.example/1" },
        { title: "Ada Okonkwo of Houston fined in Shell expense probe", url: "https://news.example/2" },
      ],
    });
    const report = await runResearch(request("1.50"), {
      ...deps,
      agent: createScriptedAgent({
        classify: () => ({ classifications: [], failed: true }),
      }),
    });
    expect(report.warnings.some((w) => w.code === "unclassified")).toBe(true);
    expect(report.profile.news).toEqual([]);
    expect(report.risk.reputational.hits).toEqual([]);
    expect(report.risk.reputational.status).not.toBe("hits");
    expectValidCosts(report, "1.50");
  });

  it("parallel enrich under a tight cap never exceeds it and shows the refusal", async () => {
    const { deps } = await harness();
    const report = await runResearch(request("0.04"), { ...deps, concurrency: 4 });
    expect(parseMoney(report.costs.total.amount)).toBeLessThanOrEqual(parseMoney("0.04"));
    expect(report.warnings.some((w) => w.code === "budget_exhausted")).toBe(true);
    expectValidCosts(report, "0.04");
  });
});

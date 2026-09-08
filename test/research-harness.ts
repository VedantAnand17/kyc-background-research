import { expect } from "vitest";
import { parseMoney } from "../src/budget/money.js";
import { openDatabase, type Db } from "../src/db/sqlite.js";
import { createLogger } from "../src/logger.js";
import { createPerfloClient } from "../src/perflo/client.js";
import type { ResearchRequest, ResearchReport } from "../src/api/schemas.js";
import { runResearch, type OrchestratorDeps } from "../src/research/orchestrator.js";
import { startFakePerflo, type FakePerflo } from "./fake-perflo.js";
import { createScriptedAgent } from "./scripted-agent.js";

export const ADA: Omit<ResearchRequest, "maxBudget" | "options"> = {
  firstName: "Ada",
  lastName: "Okonkwo",
  dateOfBirth: "1991-04-12",
  address: { city: "Lagos", region: "Lagos", country: "NG" },
};

export const HOUSTON_TITLE = "Ada Okonkwo of Houston fined in Shell expense probe";
export const LAGOS_TITLE = "Paystack names Ada Okonkwo product lead";

export const CONFIRMED_PEOPLE = {
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

export function researchRequest(amount: string, deadlineMs?: number): ResearchRequest {
  return {
    ...ADA,
    maxBudget: { amount, currency: "USD" },
    ...(deadlineMs ? { options: { deadlineMs } } : {}),
  };
}

export interface ResearchHarness {
  readonly server: FakePerflo;
  readonly db: Db;
  readonly deps: OrchestratorDeps;
}

export async function startResearchHarness(
  over: { readonly timeoutMs?: number; readonly concurrency?: number } = {},
): Promise<ResearchHarness> {
  const server = await startFakePerflo();
  server.setPayOutput("stableenrich-minerva-resolve", CONFIRMED_PEOPLE);
  server.setPayOutput("ottoai-filtered-news", {
    articles: [
      { title: LAGOS_TITLE, url: "https://news.example/lagos" },
      { title: HOUSTON_TITLE, url: "https://news.example/houston" },
    ],
  });
  server.setSearchResults("PEP sanctions watchlist screening", []);
  server.setSearchResults("web search", []);
  const db = openDatabase(":memory:");
  return {
    server,
    db,
    deps: {
      db,
      log: createLogger("silent"),
      client: createPerfloClient({
        baseUrl: server.baseUrl,
        agentKey: "perflo_test_fake",
        timeoutMs: over.timeoutMs ?? 2_000,
      }),
      agent: createScriptedAgent(),
      ...(over.concurrency !== undefined ? { concurrency: over.concurrency } : {}),
    },
  };
}

export function expectValidCosts(report: ResearchReport, cap: string): void {
  const total = parseMoney(report.costs.total.amount);
  const budget = parseMoney(report.costs.budget.amount);
  const remaining = parseMoney(report.costs.remaining.amount);
  const sum = report.costs.calls.reduce((acc, row) => acc + parseMoney(row.charged.amount), 0n);
  expect(budget).toBe(parseMoney(cap));
  expect(total).toBe(sum);
  expect(total).toBeLessThanOrEqual(budget);
  expect(remaining).toBe(budget - total);
  expect(report.costs.total.amount).toMatch(/^\d+\.\d{6}$/);
}

export function houstonAttachedToPrimary(report: ResearchReport): boolean {
  const inNews = report.profile.news.some((row) => row.title.includes("Houston"));
  const inRisk = report.risk.reputational.hits.some((row) => row.summary.includes("Houston"));
  return inNews || inRisk;
}

export function warningCodes(report: ResearchReport): string[] {
  return report.warnings.map((row) => row.code);
}

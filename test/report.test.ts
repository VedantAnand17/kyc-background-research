import { describe, expect, it } from "vitest";
import { parseMoney, type Micro } from "../src/budget/money.js";
import type { SourceRecord } from "../src/evidence/store.js";
import {
  assembleReport,
  assertReportInvariants,
  type AssembleReportInput,
} from "../src/evidence/report.js";
import type { IdentityDecision } from "../src/identity/matcher.js";
import { ReportSchema, type ResearchRequest } from "../src/api/schemas.js";

const REQUEST: ResearchRequest = {
  firstName: "Ada",
  lastName: "Okonkwo",
  dateOfBirth: "1991-04-12",
  address: { city: "Lagos", country: "NG" },
  maxBudget: { amount: "1.50", currency: "USD" },
};

const CONFIRMED: IdentityDecision = {
  status: "confirmed",
  primaryCandidateId: "c1",
  candidates: [
    {
      id: "c1",
      confidence: 0.86,
      label: "confirmed",
      matchedOn: ["name", "location"],
      conflicts: [],
      sourceIds: ["s1"],
    },
  ],
  warnings: [],
};

const AMBIGUOUS: IdentityDecision = {
  status: "ambiguous",
  primaryCandidateId: null,
  candidates: [
    {
      id: "c1",
      confidence: 0.6,
      label: "probable",
      matchedOn: ["name"],
      conflicts: [],
      sourceIds: ["s1"],
    },
    {
      id: "c2",
      confidence: 0.58,
      label: "probable",
      matchedOn: ["name"],
      conflicts: [],
      sourceIds: ["s2"],
    },
  ],
  warnings: [],
};

function source(id: string, capability: string, extras: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id,
    jobId: "req_1",
    ledgerId: `led_${id}`,
    vendor: "stableenrich-minerva-resolve",
    capability,
    purpose: "resolve candidates",
    candidateId: "c1",
    status: "succeeded",
    raw: {},
    extracted: { facts: { company: "Paystack" }, summary: "Ada" },
    retrievedAt: "2026-09-08T10:00:00.000Z",
    ...extras,
  };
}

function input(over: Partial<AssembleReportInput> = {}): AssembleReportInput {
  const calls = over.calls ?? [
    {
      sourceId: "s1",
      vendor: "stableenrich-minerva-resolve",
      capability: "find_people",
      status: "succeeded" as const,
      chargedMicro: parseMoney("0.025200"),
      transactionId: "tx-1",
    },
  ];
  const spent = calls.reduce((sum, row) => sum + row.chargedMicro, 0n);
  return {
    requestId: "req_1",
    request: REQUEST,
    tier: "standard",
    identity: CONFIRMED,
    sources: [source("s1", "find_people")],
    calls,
    capMicro: parseMoney("1.50"),
    warnings: [],
    timing: { totalMs: 1200, deadlineHit: false, phases: { resolve: 400 } },
    narrative: {
      candidateSummaries: { c1: "Product lead at Paystack, Lagos" },
      reputationalSummaries: {},
      rationale: "No watchlist or adverse-media hits on the primary candidate.",
    },
    classifications: [],
    watchlistScreened: false,
    watchlistHits: false,
    screenRan: true,
    ledgerSpentMicro: spent as Micro,
    ...over,
  };
}

describe("report invariants", () => {
  it("costs.total equals the sum of calls and the ledger, and never exceeds budget", () => {
    const report = assembleReport(input());
    expect(parseMoney(report.costs.total.amount)).toBe(parseMoney("0.025200"));
    expect(parseMoney(report.costs.budget.amount)).toBe(parseMoney("1.50"));
    expect(parseMoney(report.costs.remaining.amount)).toBe(parseMoney("1.474800"));
    const sum = report.costs.calls.reduce((acc, row) => acc + parseMoney(row.charged.amount), 0n);
    expect(parseMoney(report.costs.total.amount)).toBe(sum);
    expect(parseMoney(report.costs.total.amount)).toBeLessThanOrEqual(parseMoney(report.costs.budget.amount));
  });

  it("every sourceIds entry references a listed source", () => {
    const report = assembleReport(input());
    const ids = new Set(report.sources.map((s) => s.id));
    for (const candidate of report.identity.candidates) {
      for (const id of candidate.sourceIds) expect(ids.has(id)).toBe(true);
    }
    for (const row of report.profile.employment) {
      for (const id of row.sourceIds) expect(ids.has(id)).toBe(true);
    }
  });

  it("profile is empty when identity is ambiguous or not_found, with a warning", () => {
    const report = assembleReport(
      input({
        identity: AMBIGUOUS,
        sources: [source("s1", "find_people"), source("s2", "find_people", { candidateId: "c2" })],
        calls: [
          {
            sourceId: "s1",
            vendor: "v",
            capability: "find_people",
            status: "succeeded",
            chargedMicro: parseMoney("0.01"),
            transactionId: "tx-1",
          },
          {
            sourceId: "s2",
            vendor: "v",
            capability: "find_people",
            status: "succeeded",
            chargedMicro: parseMoney("0.01"),
            transactionId: "tx-2",
          },
        ],
        ledgerSpentMicro: parseMoney("0.02"),
        warnings: [
          {
            code: "identity_ambiguous",
            message: "Two or more candidates remain too close to select a primary; profile sections are empty.",
          },
        ],
      }),
    );
    expect(report.profile.employment).toEqual([]);
    expect(report.profile.news).toEqual([]);
    expect(report.profile.contacts.emails).toEqual([]);
    expect(report.warnings.some((w) => w.code === "identity_ambiguous")).toBe(true);
  });

  it("risk.overall.level is unknown when identity is ambiguous or not_found", () => {
    const report = assembleReport(
      input({
        identity: AMBIGUOUS,
        watchlistHits: true,
        sources: [source("s1", "find_people"), source("s2", "find_people", { candidateId: "c2" })],
        calls: [
          {
            sourceId: "s1",
            vendor: "v",
            capability: "find_people",
            status: "succeeded",
            chargedMicro: parseMoney("0.01"),
            transactionId: "tx-1",
          },
          {
            sourceId: "s2",
            vendor: "v",
            capability: "find_people",
            status: "succeeded",
            chargedMicro: parseMoney("0.01"),
            transactionId: "tx-2",
          },
        ],
        ledgerSpentMicro: parseMoney("0.02"),
      }),
    );
    expect(report.risk.overall.level).toBe("unknown");
  });

  it("amounts are formatted with six fractional digits", () => {
    const report = assembleReport(input());
    expect(report.costs.budget.amount).toMatch(/^\d+\.\d{6}$/);
    expect(report.costs.total.amount).toMatch(/^\d+\.\d{6}$/);
    expect(report.costs.remaining.amount).toMatch(/^\d+\.\d{6}$/);
    for (const row of report.costs.calls) expect(row.charged.amount).toMatch(/^\d+\.\d{6}$/);
  });

  it("a report that fails the schema is rejected loudly", () => {
    expect(() => ReportSchema.parse({ requestId: "x" })).toThrow();
  });

  it("rejects a report whose sourceIds cite a source that is not listed", () => {
    const report = assembleReport(input());
    const broken = {
      ...report,
      identity: {
        ...report.identity,
        candidates: report.identity.candidates.map((c) => ({ ...c, sourceIds: ["missing"] })),
      },
    };
    expect(() => assertReportInvariants(broken, parseMoney("0.025200"))).toThrow(/sourceIds/);
  });

  it("marks every risk category not_screened and overall unknown when the screen did not run", () => {
    const report = assembleReport(
      input({
        screenRan: false,
        classifications: [
          { sourceId: "s1", aboutPrimary: true, severity: "high", summary: "should be ignored" },
        ],
        watchlistHits: true,
      }),
    );
    expect(report.risk.pep.status).toBe("not_screened");
    expect(report.risk.sanctions.status).toBe("not_screened");
    expect(report.risk.fraud.status).toBe("not_screened");
    expect(report.risk.reputational.status).toBe("not_screened");
    expect(report.risk.reputational.hits).toEqual([]);
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
});

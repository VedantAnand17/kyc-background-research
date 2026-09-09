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
    vendor: "stableenrich-exa-search",
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
      vendor: "stableenrich-exa-search",
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

  it("a hit keeps the classifier's per-article summary when its source yielded several articles", () => {
    // One news lookup returned a Lagos article about the primary and a Houston namesake. The narrative
    // summarises the whole source, so borrowing it would attach the namesake to the primary's hit.
    const report = assembleReport(
      input({
        sources: [source("s1", "find_people"), source("n1", "search_news"), source("w1", "screen_watchlist")],
        narrative: {
          candidateSummaries: { c1: "Product lead at Paystack, Lagos" },
          reputationalSummaries: { n1: "Named product lead at Paystack; a Houston namesake was fined in a Shell probe.", w1: "Clean watchlist screen." },
          rationale: "Low risk.",
        },
        classifications: [
          { sourceId: "n1", aboutPrimary: true, severity: "low", summary: "Paystack names Ada Okonkwo product lead.", title: "Paystack names Ada Okonkwo product lead" },
          { sourceId: "n1", aboutPrimary: false, severity: "low", summary: "Houston namesake fined.", title: "Ada Okonkwo of Houston fined in Shell expense probe" },
          { sourceId: "w1", aboutPrimary: true, severity: "low", summary: "No watchlist matches." },
        ],
      }),
    );
    const summaries = report.risk.reputational.hits.map((hit) => hit.summary);
    expect(summaries).toEqual(["Paystack names Ada Okonkwo product lead.", "Clean watchlist screen."]);
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

  it("keeps news that is not about the primary candidate out of the profile", () => {
    const newsSource = source("s-news", "search_news", {
      candidateId: null,
      extracted: {
        facts: {
          articles: [
            { title: "Ada Okonkwo joins Paystack in Lagos", outlet: "TechCabal" },
            { title: "Houston Ada Okonkwo charged in wire fraud", outlet: "Houston Chronicle" },
          ],
        },
        summary: "two articles",
      },
    });
    const report = assembleReport(
      input({
        sources: [source("s1", "find_people"), newsSource],
        classifications: [
          {
            sourceId: "s-news",
            title: "Ada Okonkwo joins Paystack in Lagos",
            aboutPrimary: true,
            severity: "low",
            summary: "Employment announcement about the Lagos candidate.",
          },
          {
            sourceId: "s-news",
            title: "Houston Ada Okonkwo charged in wire fraud",
            aboutPrimary: false,
            severity: "high",
            summary: "Different person in Houston.",
          },
        ],
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
            sourceId: "s-news",
            vendor: "v",
            capability: "search_news",
            status: "succeeded",
            chargedMicro: parseMoney("0.01"),
            transactionId: "tx-2",
          },
        ],
        ledgerSpentMicro: parseMoney("0.02"),
      }),
    );
    expect(report.profile.news.map((row) => row.title)).toEqual(["Ada Okonkwo joins Paystack in Lagos"]);
    expect(report.risk.reputational.hits).toHaveLength(1);
    expect(report.risk.reputational.hits[0]?.summary).toMatch(/Lagos/);
  });

  it("keeps non-adverse coverage in the profile but out of reputational hits and the overall level", () => {
    // Live 2026-09-09: Satya Nadella testified as a witness in Musk v. OpenAI; "lawsuit" matched the adverse
    // query, every article was about him, and seven medium hits made the CEO of Microsoft "medium" risk.
    const newsSource = source("s-news", "search_news", {
      candidateId: null,
      extracted: {
        facts: {
          articles: [
            { title: "Nadella testifies in OpenAI trial", outlet: "CNBC" },
            { title: "Ada Okonkwo indicted for wire fraud in Lagos", outlet: "Punch" },
          ],
        },
        summary: "two articles",
      },
    });
    const report = assembleReport(
      input({
        sources: [source("s1", "find_people"), newsSource],
        classifications: [
          { sourceId: "s-news", title: "Nadella testifies in OpenAI trial", aboutPrimary: true, severity: "none", summary: "Witness testimony; no allegation." },
          { sourceId: "s-news", title: "Ada Okonkwo indicted for wire fraud in Lagos", aboutPrimary: true, severity: "high", summary: "Indicted for wire fraud." },
        ],
        calls: [
          { sourceId: "s1", vendor: "v", capability: "find_people", status: "succeeded", chargedMicro: parseMoney("0.01"), transactionId: "tx-1" },
          { sourceId: "s-news", vendor: "v", capability: "search_news", status: "succeeded", chargedMicro: parseMoney("0.01"), transactionId: "tx-2" },
        ],
        ledgerSpentMicro: parseMoney("0.02"),
      }),
    );
    expect(report.profile.news.map((row) => row.title)).toEqual([
      "Nadella testifies in OpenAI trial",
      "Ada Okonkwo indicted for wire fraud in Lagos",
    ]);
    expect(report.risk.reputational.hits.map((hit) => hit.severity)).toEqual(["high"]);
    expect(report.risk.overall.level).toBe("high");
  });

  it("reports clear when every article about the primary is non-adverse", () => {
    const report = assembleReport(
      input({
        sources: [source("s1", "find_people"), source("n1", "search_news")],
        classifications: [{ sourceId: "n1", aboutPrimary: true, severity: "none", summary: "Quoted as an industry expert." }],
      }),
    );
    expect(report.risk.reputational.status).toBe("clear");
    expect(report.risk.reputational.hits).toEqual([]);
    expect(report.risk.overall.level).toBe("low");
  });

  it("never treats news as about the primary when classification produced no rows", () => {
    const newsSource = source("s-news", "search_news", {
      candidateId: null,
      extracted: {
        facts: {
          articles: [{ title: "Ada Okonkwo of Houston fined in Shell expense probe", outlet: "Houston Chronicle" }],
        },
        summary: "one article",
      },
    });
    const report = assembleReport(
      input({
        sources: [source("s1", "find_people"), newsSource],
        classifications: [],
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
            sourceId: "s-news",
            vendor: "v",
            capability: "search_news",
            status: "succeeded",
            chargedMicro: parseMoney("0.01"),
            transactionId: "tx-2",
          },
        ],
        ledgerSpentMicro: parseMoney("0.02"),
      }),
    );
    expect(report.profile.news).toEqual([]);
    expect(report.risk.reputational.hits).toEqual([]);
    expect(report.risk.reputational.status).toBe("clear");
  });

  it("reports reputational not_screened and overall unknown when classification failed", () => {
    // Articles came back but the classifier never ran to completion: nothing was ruled in or out,
    // so "clear" would be a false negative. The `unclassified` warning already says why.
    const report = assembleReport(
      input({
        classifications: [],
        classificationFailed: true,
        warnings: [{ code: "unclassified", message: "Risk classification failed." }],
      }),
    );
    expect(report.risk.reputational.status).toBe("not_screened");
    expect(report.risk.reputational.hits).toEqual([]);
    expect(report.risk.fraud.status).toBe("not_screened");
    expect(report.risk.overall.level).toBe("unknown");
    expect(report.warnings.filter((w) => w.code === "unclassified")).toHaveLength(1);
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

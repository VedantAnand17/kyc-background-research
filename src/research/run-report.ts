// Draft report for one orchestrator run. PRD.md sections 5.4 and 6.6.
// M6 owns the dedicated assembler (invariants helper, richer profile mapping, API).
import { toMoney, type Micro } from "../budget/money.js";
import type { SourceRecord } from "../evidence/store.js";
import type { IdentityDecision } from "../identity/matcher.js";
import type { ResearchReport, ResearchRequest } from "../api/schemas.js";
import { ReportSchema } from "../api/schemas.js";
import type { NarrativeFields, RiskClassification } from "./agent.js";
import type { Tier } from "./capabilities.js";

export interface Warning {
  readonly code: string;
  readonly message: string;
}

export interface CostCall {
  readonly sourceId: string;
  readonly vendor: string;
  readonly capability: string;
  readonly status: "succeeded" | "failed";
  readonly chargedMicro: Micro;
  readonly transactionId: string | null;
}

export interface RunReportInput {
  readonly requestId: string;
  readonly request: ResearchRequest;
  readonly tier: Tier;
  readonly identity: IdentityDecision;
  readonly sources: readonly SourceRecord[];
  readonly calls: readonly CostCall[];
  readonly capMicro: Micro;
  readonly warnings: readonly Warning[];
  readonly timing: { readonly totalMs: number; readonly deadlineHit: boolean; readonly phases: Record<string, number> };
  readonly narrative: NarrativeFields;
  readonly classifications: readonly RiskClassification[];
  readonly watchlistScreened: boolean;
  readonly watchlistHits: boolean;
}

function emptyRisk(status: "clear" | "hits" | "not_screened" = "not_screened") {
  return { status, hits: [] as ResearchReport["risk"]["pep"]["hits"] };
}

function profileFrom(sources: readonly SourceRecord[], primaryId: string | null): ResearchReport["profile"] {
  const empty = {
    employment: [] as ResearchReport["profile"]["employment"],
    education: [] as ResearchReport["profile"]["education"],
    contacts: { emails: [] as ResearchReport["profile"]["contacts"]["emails"], phones: [] as ResearchReport["profile"]["contacts"]["phones"] },
    socialProfiles: [] as ResearchReport["profile"]["socialProfiles"],
    news: [] as ResearchReport["profile"]["news"],
    publicRecords: [] as ResearchReport["profile"]["publicRecords"],
  };
  if (!primaryId) return empty;

  for (const source of sources) {
    if (source.status !== "succeeded") continue;
    const extracted = source.extracted as { facts?: Record<string, unknown> } | undefined;
    const facts = extracted?.facts ?? {};
    if (source.capability === "get_professional_profile" || source.capability === "enrich_person") {
      const company = typeof facts.company === "string" ? facts.company : undefined;
      if (company) empty.employment.push({ company, sourceIds: [source.id] });
      if (Array.isArray(facts.emails)) {
        for (const email of facts.emails) {
          const value = typeof email === "string" ? email : undefined;
          if (value) empty.contacts.emails.push({ value, sourceIds: [source.id] });
        }
      }
      if (Array.isArray(facts.phones)) {
        for (const phone of facts.phones) {
          const value = typeof phone === "string" ? phone : undefined;
          if (value) empty.contacts.phones.push({ value, sourceIds: [source.id] });
        }
      }
    }
    if (source.capability === "get_social_profile") {
      const rec = facts as Record<string, unknown>;
      const handle = typeof rec.handle === "string" ? rec.handle : undefined;
      if (handle) empty.socialProfiles.push({ handle, sourceIds: [source.id] });
    }
    if (source.capability === "search_news") {
      const articles = Array.isArray(facts.articles) ? facts.articles : [];
      for (const article of articles) {
        const row = article && typeof article === "object" ? (article as { title?: string; outlet?: string }) : {};
        if (row.title) empty.news.push({ title: row.title, outlet: row.outlet, sourceIds: [source.id] });
      }
    }
    if (source.capability === "search_filings") {
      const filings = Array.isArray(facts.filings) ? facts.filings : [];
      for (const filing of filings) {
        if (typeof filing === "string") empty.publicRecords.push({ kind: "other", title: filing, sourceIds: [source.id] });
      }
    }
  }
  return empty;
}

export function buildRunReport(input: RunReportInput): ResearchReport {
  const spent = input.calls.reduce((sum, row) => sum + row.chargedMicro, 0n);
  const remaining = input.capMicro > spent ? input.capMicro - spent : 0n;
  const confirmed = input.identity.status === "confirmed" || input.identity.status === "probable";
  const reputationalHits = input.classifications
    .filter((row) => row.aboutPrimary)
    .map((row) => ({
      summary: input.narrative.reputationalSummaries[row.sourceId] ?? row.summary,
      severity: row.severity,
      sourceIds: [row.sourceId],
      candidateId: input.identity.primaryCandidateId ?? "c1",
    }));

  let overall: "low" | "medium" | "high" | "unknown" = "low";
  if (!confirmed) overall = "unknown";
  else if (input.watchlistHits || reputationalHits.some((h) => h.severity === "high")) overall = "high";
  else if (reputationalHits.some((h) => h.severity === "medium")) overall = "medium";

  const watch = input.watchlistScreened
    ? input.watchlistHits
      ? { status: "hits" as const, hits: [] }
      : emptyRisk("clear")
    : emptyRisk("not_screened");

  const report = {
    requestId: input.requestId,
    subject: {
      firstName: input.request.firstName,
      lastName: input.request.lastName,
      dateOfBirth: input.request.dateOfBirth,
      address: input.request.address,
    },
    tier: input.tier,
    identity: {
      status: input.identity.status,
      primaryCandidateId: input.identity.primaryCandidateId,
      candidates: input.identity.candidates.map((c) => ({
        id: c.id,
        confidence: c.confidence,
        label: c.label,
        summary: input.narrative.candidateSummaries[c.id] ?? "narrative unavailable",
        matchedOn: [...c.matchedOn],
        conflicts: [...c.conflicts],
        sourceIds: [...c.sourceIds],
      })),
    },
    profile: confirmed
      ? profileFrom(input.sources, input.identity.primaryCandidateId)
      : profileFrom([], null),
    risk: {
      pep: watch,
      sanctions: watch,
      fraud: emptyRisk("not_screened"),
      reputational: {
        status: reputationalHits.length > 0 ? ("hits" as const) : ("clear" as const),
        hits: reputationalHits,
      },
      overall: {
        level: overall,
        rationale: input.narrative.rationale || "narrative unavailable",
      },
    },
    sources: input.sources.map((s) => ({
      id: s.id,
      vendor: s.vendor,
      capability: s.capability,
      purpose: s.purpose,
      retrievedAt: s.retrievedAt,
      status: s.status,
    })),
    costs: {
      budget: toMoney(input.capMicro),
      total: toMoney(spent),
      remaining: toMoney(remaining),
      calls: input.calls.map((row) => ({
        sourceId: row.sourceId,
        vendor: row.vendor,
        capability: row.capability,
        status: row.status,
        charged: toMoney(row.chargedMicro),
        transactionId: row.transactionId,
      })),
    },
    warnings: [...input.warnings],
    timing: input.timing,
  };

  return ReportSchema.parse(report);
}

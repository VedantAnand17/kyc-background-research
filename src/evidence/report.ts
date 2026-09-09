// Report assembler. PRD.md sections 5.4 and 6.6.
// Code fills identity, profile, risk statuses, costs (from the ledger), warnings, timing.
// The LLM fills exactly three narrative fields via structured output: candidate summaries,
// reputational hit summaries, risk.overall.rationale. On LLM failure they read "narrative unavailable".
// Overall risk level is a rule (section 5.4), never a model output.
// The finished object is validated against ReportSchema and its invariants before it is returned.
import { toMoney, type Micro } from "../budget/money.js";
import type { SourceRecord } from "./store.js";
import type { IdentityDecision } from "../identity/matcher.js";
import {
  assertReportInvariants,
  ReportSchema,
  type ResearchReport,
  type ResearchRequest,
} from "../api/schemas.js";

export { assertReportInvariants, ReportInvariantError } from "../api/schemas.js";
import type { NarrativeFields, RiskClassification } from "../research/agent.js";
import type { Tier } from "../research/capabilities.js";

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

export interface AssembleReportInput {
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
  /** The adverse-media classifier did not finish, so nothing was ruled in or out. Never reported as clear. */
  readonly classificationFailed?: boolean;
  readonly watchlistScreened: boolean;
  readonly watchlistHits: boolean;
  readonly screenRan: boolean;
  readonly ledgerSpentMicro: Micro;
}

function emptyRisk(status: "clear" | "hits" | "not_screened" = "not_screened") {
  return { status, hits: [] as ResearchReport["risk"]["pep"]["hits"] };
}

function emptyProfile(): ResearchReport["profile"] {
  return {
    employment: [],
    education: [],
    contacts: { emails: [], phones: [] },
    socialProfiles: [],
    news: [],
    publicRecords: [],
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function contactValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const raw = typeof item === "string" ? item : asString((item as { value?: unknown })?.value);
    if (raw) out.push(raw);
  }
  return out;
}

function attachedToPrimary(source: SourceRecord, primaryId: string): boolean {
  return source.candidateId === primaryId || source.candidateId === null;
}

function titlesMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function newsAboutPrimary(
  sourceId: string,
  title: string,
  classifications: readonly RiskClassification[],
): boolean {
  if (classifications.length === 0) return false;
  const withTitles = classifications.filter((row) => row.title);
  if (withTitles.length > 0) {
    return withTitles.some((row) => titlesMatch(row.title!, title) && row.aboutPrimary);
  }
  return classifications.some((row) => row.sourceId === sourceId && row.aboutPrimary);
}

function profileFrom(
  sources: readonly SourceRecord[],
  primaryId: string | null,
  classifications: readonly RiskClassification[],
): ResearchReport["profile"] {
  const profile = emptyProfile();
  if (!primaryId) return profile;

  for (const source of sources) {
    if (source.status !== "succeeded") continue;
    if (!attachedToPrimary(source, primaryId)) continue;
    const extracted = source.extracted as { facts?: Record<string, unknown> } | undefined;
    const facts = extracted?.facts ?? {};
    const ids = [source.id];

    if (source.capability === "get_professional_profile" || source.capability === "enrich_person") {
      const company = asString(facts.company);
      const title = asString(facts.title) ?? asString(facts.headline);
      if (company || title) profile.employment.push({ ...(title ? { title } : {}), ...(company ? { company } : {}), sourceIds: ids });
      for (const value of contactValues(facts.emails)) profile.contacts.emails.push({ value, sourceIds: ids });
      for (const value of contactValues(facts.phones)) profile.contacts.phones.push({ value, sourceIds: ids });
    }
    if (source.capability === "get_social_profile") {
      const handle = asString(facts.handle) ?? asString(facts.username);
      const url = asString(facts.url) ?? asString(facts.profileUrl);
      const networkRaw = asString(facts.network);
      const network =
        networkRaw === "linkedin" || networkRaw === "x" || networkRaw === "instagram" || networkRaw === "other"
          ? networkRaw
          : handle || url
            ? ("other" as const)
            : undefined;
      if (handle || url) {
        profile.socialProfiles.push({
          ...(network ? { network } : {}),
          ...(url ? { url } : {}),
          ...(handle ? { handle } : {}),
          sourceIds: ids,
        });
      }
    }
    if (source.capability === "search_news") {
      const articles = Array.isArray(facts.articles) ? facts.articles : [];
      for (const article of articles) {
        const row = article && typeof article === "object" ? (article as Record<string, unknown>) : {};
        const title = asString(row.title);
        if (!title) continue;
        if (!newsAboutPrimary(source.id, title, classifications)) continue;
        profile.news.push({
          title,
          ...(asString(row.url) ? { url: asString(row.url) } : {}),
          ...(asString(row.publishedAt) ? { publishedAt: asString(row.publishedAt) } : {}),
          ...(asString(row.outlet) ? { outlet: asString(row.outlet) } : {}),
          sourceIds: ids,
        });
      }
    }
    if (source.capability === "search_filings") {
      const filings = Array.isArray(facts.filings) ? facts.filings : [];
      for (const filing of filings) {
        const title = typeof filing === "string" ? filing : asString((filing as { title?: unknown }).title);
        if (!title) continue;
        profile.publicRecords.push({ kind: "other", title, sourceIds: ids });
      }
    }
  }
  return profile;
}

function ensureWarning(warnings: Warning[], code: string, message: string): void {
  if (!warnings.some((w) => w.code === code)) warnings.push({ code, message });
}

export function assembleReport(input: AssembleReportInput): ResearchReport {
  const spent = input.calls.reduce((sum, row) => sum + row.chargedMicro, 0n);
  const remaining = input.capMicro > spent ? input.capMicro - spent : 0n;
  const confirmed = input.identity.status === "confirmed" || input.identity.status === "probable";
  const warnings = [...input.warnings];

  // The narrative summarises a source; a hit is one article. When one news lookup yielded several articles,
  // the source-level summary can describe an excluded namesake, so only a source with exactly one
  // classification may borrow it and the others keep the classifier's per-article summary.
  const perSource = new Map<string, number>();
  for (const row of input.classifications) perSource.set(row.sourceId, (perSource.get(row.sourceId) ?? 0) + 1);
  const reputationalHits = input.screenRan
    ? input.classifications
        .filter((row): row is RiskClassification & { severity: "low" | "medium" | "high" } => row.aboutPrimary && row.severity !== "none")
        .map((row) => ({
          summary: (perSource.get(row.sourceId) === 1 ? input.narrative.reputationalSummaries[row.sourceId] : undefined) ?? row.summary,
          severity: row.severity,
          sourceIds: [row.sourceId],
          candidateId: input.identity.primaryCandidateId ?? "c1",
        }))
    : [];

  if (!input.screenRan) {
    ensureWarning(
      warnings,
      "pep_not_screened",
      "PEP screening did not run; the category is reported as not_screened.",
    );
    ensureWarning(
      warnings,
      "sanctions_not_screened",
      "Sanctions screening did not run; the category is reported as not_screened.",
    );
    ensureWarning(
      warnings,
      "fraud_not_screened",
      "Fraud screening did not run; the category is reported as not_screened.",
    );
    ensureWarning(
      warnings,
      "reputational_not_screened",
      "Adverse-media screening did not run; the category is reported as not_screened.",
    );
  }

  const adverseMediaScreened = input.screenRan && !input.classificationFailed;

  let overall: "low" | "medium" | "high" | "unknown" = "low";
  if (!confirmed || !adverseMediaScreened) overall = "unknown";
  else if (input.watchlistHits || reputationalHits.some((h) => h.severity === "high")) overall = "high";
  else if (reputationalHits.some((h) => h.severity === "medium")) overall = "medium";

  const watch = input.screenRan
    ? input.watchlistScreened
      ? input.watchlistHits
        ? { status: "hits" as const, hits: [] }
        : emptyRisk("clear")
      : emptyRisk("not_screened")
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
    profile: confirmed ? profileFrom(input.sources, input.identity.primaryCandidateId, input.classifications) : emptyProfile(),
    risk: {
      pep: watch,
      sanctions: watch,
      fraud: emptyRisk("not_screened"),
      reputational: adverseMediaScreened
        ? {
            status: reputationalHits.length > 0 ? ("hits" as const) : ("clear" as const),
            hits: reputationalHits,
          }
        : emptyRisk("not_screened"),
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
    warnings,
    timing: input.timing,
  };

  const parsed = ReportSchema.parse(report);
  assertReportInvariants(parsed, input.ledgerSpentMicro);
  return parsed;
}

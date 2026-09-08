// Request and Report Zod schemas. PRD.md sections 5.1 and 5.4 define every field and invariant.
// These schemas are shared by input validation, the OpenAPI document, and report validation.
import { z } from "@hono/zod-openapi";
import { parseMoney } from "../budget/money.js";

function utcToday(): string {
  const now = new Date();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${now.getUTCFullYear()}-${m}-${d}`;
}

const MoneySchema = z
  .object({
    amount: z.string().regex(/^\d+(\.\d{1,6})?$/, "decimal string with up to six fractional digits"),
    currency: z.literal("USD"),
  })
  .strict()
  .refine(
    (m) => {
      try {
        const micro = parseMoney(m.amount);
        return micro > 0n && micro <= parseMoney("1000");
      } catch {
        return false;
      }
    },
    { message: "maxBudget.amount must be greater than 0 and at most 1000.000000", path: ["amount"] },
  )
  .openapi("Money");

export const AddressSchema = z
  .object({
    line1: z.string().trim().min(1).max(200).optional(),
    city: z.string().trim().min(1).max(100).optional(),
    region: z.string().trim().min(1).max(100).optional(),
    country: z.string().length(2).toUpperCase().optional(),
  })
  .strict()
  .openapi("Address");

export const ResearchRequestSchema = z
  .object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    dateOfBirth: z
      .iso
      .date()
      .refine((d) => d < utcToday(), { message: "dateOfBirth must be in the past" })
      .optional(),
    address: AddressSchema.optional(),
    maxBudget: MoneySchema,
    options: z
      .object({ deadlineMs: z.number().int().min(5_000).max(120_000).optional() })
      .strict()
      .optional(),
  })
  .strict()
  .openapi("ResearchRequest");

export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;

const ReportMoney = z
  .object({
    amount: z.string().regex(/^\d+\.\d{6}$/, "exactly six fractional digits"),
    currency: z.literal("USD"),
  })
  .openapi("ReportMoney");

const WarningSchema = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .strict()
  .openapi("Warning");

const SourceIdList = z.array(z.string());

const RiskHitSchema = z
  .object({
    summary: z.string(),
    severity: z.enum(["low", "medium", "high"]),
    sourceIds: SourceIdList,
    candidateId: z.string(),
  })
  .strict();

const RiskStatusSchema = z
  .object({
    status: z.enum(["clear", "hits", "not_screened"]),
    hits: z.array(RiskHitSchema),
  })
  .strict();

const EmploymentSchema = z
  .object({
    title: z.string().optional(),
    company: z.string().optional(),
    from: z.string().optional(),
    to: z.string().nullable().optional(),
    sourceIds: SourceIdList,
  })
  .strict();

const EducationSchema = z
  .object({
    institution: z.string().optional(),
    degree: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    sourceIds: SourceIdList,
  })
  .strict();

const ContactSchema = z
  .object({
    value: z.string(),
    sourceIds: SourceIdList,
  })
  .strict();

const SocialSchema = z
  .object({
    network: z.enum(["linkedin", "x", "instagram", "other"]).optional(),
    url: z.string().optional(),
    handle: z.string().optional(),
    sourceIds: SourceIdList,
  })
  .strict();

const NewsSchema = z
  .object({
    title: z.string(),
    url: z.string().optional(),
    publishedAt: z.string().optional(),
    outlet: z.string().optional(),
    sourceIds: SourceIdList,
  })
  .strict();

const PublicRecordSchema = z
  .object({
    kind: z.enum(["sec_filing", "other"]),
    title: z.string(),
    url: z.string().optional(),
    sourceIds: SourceIdList,
  })
  .strict();

export const ReportSchema = z
  .object({
    requestId: z.string(),
    subject: z.object({
      firstName: z.string(),
      lastName: z.string(),
      dateOfBirth: z.string().optional(),
      address: AddressSchema.optional(),
    }),
    tier: z.enum(["basic", "standard", "deep"]),
    identity: z.object({
      status: z.enum(["confirmed", "probable", "ambiguous", "not_found"]),
      primaryCandidateId: z.string().nullable(),
      candidates: z.array(
        z.object({
          id: z.string(),
          confidence: z.number().min(0).max(1),
          label: z.enum(["confirmed", "probable", "possible"]),
          summary: z.string(),
          matchedOn: z.array(z.enum(["name", "dob", "location", "corroboration"])),
          conflicts: z.array(z.enum(["name", "dob", "location", "corroboration"])),
          sourceIds: SourceIdList,
        }),
      ),
    }),
    profile: z.object({
      employment: z.array(EmploymentSchema),
      education: z.array(EducationSchema),
      contacts: z.object({
        emails: z.array(ContactSchema),
        phones: z.array(ContactSchema),
      }),
      socialProfiles: z.array(SocialSchema),
      news: z.array(NewsSchema),
      publicRecords: z.array(PublicRecordSchema),
    }),
    risk: z.object({
      pep: RiskStatusSchema,
      sanctions: RiskStatusSchema,
      fraud: RiskStatusSchema,
      reputational: RiskStatusSchema,
      overall: z.object({
        level: z.enum(["low", "medium", "high", "unknown"]),
        rationale: z.string(),
      }),
    }),
    sources: z.array(
      z.object({
        id: z.string(),
        vendor: z.string(),
        capability: z.string(),
        purpose: z.string(),
        retrievedAt: z.string(),
        status: z.enum(["succeeded", "failed"]),
      }),
    ),
    costs: z.object({
      budget: ReportMoney,
      total: ReportMoney,
      remaining: ReportMoney,
      calls: z.array(
        z.object({
          sourceId: z.string(),
          vendor: z.string(),
          capability: z.string(),
          status: z.enum(["succeeded", "failed"]),
          charged: ReportMoney,
          transactionId: z.string().nullable(),
        }),
      ),
    }),
    warnings: z.array(WarningSchema),
    timing: z.object({
      totalMs: z.number().int().nonnegative(),
      deadlineHit: z.boolean(),
      phases: z.record(z.string(), z.number().int().nonnegative()),
    }),
  })
  .strict()
  .openapi("Report");

export type ResearchReport = z.infer<typeof ReportSchema>;

export const ValidationErrorSchema = z
  .object({
    error: z.literal("validation_error"),
    issues: z.array(z.unknown()),
  })
  .strict()
  .openapi("ValidationError");

export const UnavailableErrorSchema = z
  .object({
    error: z.literal("unavailable"),
    code: z.string(),
    message: z.string(),
  })
  .strict()
  .openapi("UnavailableError");

export class ReportInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportInvariantError";
  }
}

function citedSourceIds(report: ResearchReport): string[] {
  const ids: string[] = [];
  for (const candidate of report.identity.candidates) ids.push(...candidate.sourceIds);
  for (const row of report.profile.employment) ids.push(...row.sourceIds);
  for (const row of report.profile.education) ids.push(...row.sourceIds);
  for (const row of report.profile.contacts.emails) ids.push(...row.sourceIds);
  for (const row of report.profile.contacts.phones) ids.push(...row.sourceIds);
  for (const row of report.profile.socialProfiles) ids.push(...row.sourceIds);
  for (const row of report.profile.news) ids.push(...row.sourceIds);
  for (const row of report.profile.publicRecords) ids.push(...row.sourceIds);
  for (const key of ["pep", "sanctions", "fraud", "reputational"] as const) {
    for (const hit of report.risk[key].hits) ids.push(...hit.sourceIds);
  }
  for (const call of report.costs.calls) ids.push(call.sourceId);
  return ids;
}

function profileEmpty(report: ResearchReport): boolean {
  return (
    report.profile.employment.length === 0 &&
    report.profile.education.length === 0 &&
    report.profile.contacts.emails.length === 0 &&
    report.profile.contacts.phones.length === 0 &&
    report.profile.socialProfiles.length === 0 &&
    report.profile.news.length === 0 &&
    report.profile.publicRecords.length === 0
  );
}

/** Remaining section-5.4 checks the assembler owns after Zod shape validation. */
export function assertReportInvariants(report: ResearchReport, ledgerSpentMicro?: bigint): void {
  const total = parseMoney(report.costs.total.amount);
  const budget = parseMoney(report.costs.budget.amount);
  const remaining = parseMoney(report.costs.remaining.amount);
  const sum = report.costs.calls.reduce((acc, row) => acc + parseMoney(row.charged.amount), 0n);
  if (total !== sum) {
    throw new ReportInvariantError(`costs.total ${report.costs.total.amount} !== sum of calls ${sum}`);
  }
  if (total > budget) {
    throw new ReportInvariantError(`costs.total ${report.costs.total.amount} exceeds budget ${report.costs.budget.amount}`);
  }
  if (remaining !== budget - total) {
    throw new ReportInvariantError(`costs.remaining ${report.costs.remaining.amount} !== budget - total`);
  }
  if (ledgerSpentMicro !== undefined && total !== ledgerSpentMicro) {
    throw new ReportInvariantError(`costs.total does not equal the ledger settled total`);
  }
  const listed = new Set(report.sources.map((s) => s.id));
  for (const id of citedSourceIds(report)) {
    if (!listed.has(id)) throw new ReportInvariantError(`sourceIds entry ${id} is not listed in sources`);
  }
  const unresolved = report.identity.status === "ambiguous" || report.identity.status === "not_found";
  if (unresolved && !profileEmpty(report)) {
    throw new ReportInvariantError("profile must be empty when identity is ambiguous or not_found");
  }
  if (unresolved && report.risk.overall.level !== "unknown") {
    throw new ReportInvariantError("risk.overall.level must be unknown when identity is ambiguous or not_found");
  }
}

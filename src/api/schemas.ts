// Request and Report Zod schemas. PRD.md sections 5.1 and 5.4 define every field and invariant.
// These schemas are shared by input validation, the OpenAPI document, and report validation.
import { z } from "@hono/zod-openapi";

const MoneySchema = z
  .object({
    amount: z.string().regex(/^\d+(\.\d{1,6})?$/, "decimal string with up to six fractional digits"),
    currency: z.literal("USD"),
  })
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
    dateOfBirth: z.iso.date().optional(),
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

const RiskHitSchema = z
  .object({
    summary: z.string(),
    severity: z.enum(["low", "medium", "high"]),
    sourceIds: z.array(z.string()),
    candidateId: z.string(),
  })
  .strict();

const RiskStatusSchema = z
  .object({
    status: z.enum(["clear", "hits", "not_screened"]),
    hits: z.array(RiskHitSchema),
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
          sourceIds: z.array(z.string()),
        }),
      ),
    }),
    profile: z.object({
      employment: z.array(z.record(z.string(), z.unknown())),
      education: z.array(z.record(z.string(), z.unknown())),
      contacts: z.object({
        emails: z.array(z.record(z.string(), z.unknown())),
        phones: z.array(z.record(z.string(), z.unknown())),
      }),
      socialProfiles: z.array(z.record(z.string(), z.unknown())),
      news: z.array(z.record(z.string(), z.unknown())),
      publicRecords: z.array(z.record(z.string(), z.unknown())),
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

// TODO(M6): assertReportInvariants(report) for the remaining section-5.4 checks
// (source id references, primary-candidate-only profile facts) that the assembler owns.

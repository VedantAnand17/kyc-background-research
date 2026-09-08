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

// TODO(M6): ReportSchema exactly as PRD.md 5.4, plus a `assertReportInvariants(report)` helper
// that checks the invariants listed there (cost sums, source id references, primary-candidate-only
// profile facts, overall risk `unknown` when identity is ambiguous or not found).

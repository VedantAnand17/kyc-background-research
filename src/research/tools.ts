// Tool layer: the only module allowed to call PerfloClient.pay(). PRD.md section 9, ADR-0003.
//
// Responsibilities (TODO(M3)):
//   - Zod argument schema per tool; only tools allowed by the Plan are exposed to the model.
//   - Contract cache: GET /v1/vendors/{slug} at startup, refresh hourly and on 422.
//   - Vendor selection: first payable vendor in preference order whose maxChargePerCall fits headroom;
//     run-time discovery through POST /v1/search for entries with `discoveryQuery`.
//   - Field placement from contract.input.fields[].in: body -> `input`, query -> `query`. Never guess.
//   - Dedupe on (tool, canonicalized args): a repeat returns the stored Source with charged 0, cached true.
//   - Every paid call: guard.reserve() -> client.pay() with Idempotency-Key and maxCharge -> guard.settle()
//     or guard.release()/hold() per ledgerActionFor(code). Then store the Source.
//   - Concurrency limit from config.TOOL_CONCURRENCY; per-call timeout from config.VENDOR_TIMEOUT_MS.
//   - Tool results to the model are <= 1500 chars of extracted summary plus sourceId, charged, remaining.
//   - When guard.reserve() fails, return { outcome: "budget_exhausted" }; afterwards only `finish` is offered.
import type { SpendGuard } from "../budget/ledger.js";
import type { PerfloClient } from "../perflo/client.js";
import type { ToolName } from "./capabilities.js";

export interface ToolContext {
  readonly jobId: string;
  readonly client: PerfloClient;
  readonly guard: SpendGuard;
  readonly allowedTools: readonly ToolName[];
  readonly signal: AbortSignal;
}

export type ToolOutcome =
  | { readonly outcome: "ok"; readonly sourceId: string; readonly summary: string; readonly charged: string; readonly remaining: string; readonly cached: boolean }
  | { readonly outcome: "failed"; readonly sourceId: string | null; readonly reason: string; readonly charged: string; readonly remaining: string }
  | { readonly outcome: "budget_exhausted"; readonly remaining: string }
  | { readonly outcome: "unavailable"; readonly reason: string };

export function createTools(_ctx: ToolContext): never {
  throw new Error("TODO(M3): implement createTools per PRD.md section 9 (returns the AI SDK tool set)");
}

// Spend Guard: the only component that can approve a paid call. PRD.md section 7, ADR-0002.
//
// Invariant: spentMicro + reservedMicro <= capMicro, always, including under concurrency.
// reserve() must check and update in one synchronous step. Every transition is written to the
// `ledger` table before the caller makes its next network call.
//
// TODO(M2): implement SqliteLedger. Tests in test/ledger.test.ts must include a property-style
// test that N concurrent reservations of random amounts never exceed the cap.
import type { Micro } from "./money.js";

export type ReservationId = string;

export interface ReservationRequest {
  readonly vendor: string;
  readonly capability: string;
  readonly amountMicro: Micro;
}

export type ReserveResult =
  | { readonly ok: true; readonly id: ReservationId; readonly idempotencyKey: string }
  | { readonly ok: false; readonly reason: "budget_exhausted"; readonly headroomMicro: Micro };

export interface LedgerSnapshot {
  readonly capMicro: Micro;
  readonly reservedMicro: Micro;
  readonly spentMicro: Micro;
  readonly headroomMicro: Micro;
}

export interface SpendGuard {
  reserve(req: ReservationRequest): ReserveResult;
  settle(id: ReservationId, chargedMicro: Micro, transactionId: string | null): void;
  release(id: ReservationId, perfloCode: string): void;
  hold(id: ReservationId, perfloCode: string): void;
  /** Resolve a held reservation once GET /v1/transactions answers. */
  resolveHold(id: ReservationId, outcome: { readonly chargedMicro: Micro; readonly transactionId: string } | null): void;
  snapshot(): LedgerSnapshot;
}

export interface LedgerOptions {
  readonly jobId: string;
  readonly capMicro: Micro;
  /** Micro-dollars held back from phases 1-3; unlocked by the orchestrator for disambiguation. */
  readonly reserveMicro: Micro;
}

export function createSpendGuard(_opts: LedgerOptions): SpendGuard {
  throw new Error("TODO(M2): implement createSpendGuard per PRD.md section 7.2");
}

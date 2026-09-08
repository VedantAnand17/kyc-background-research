// Typed Perflo v1 client. PRD.md section 10. Adapt perflo-quickstart/src/perflo.ts: fetch only, one
// method per endpoint, unwrap `data`, turn `error` into PerfloError. Never retry a pay call blind.
//
// TODO(M2): implement. Required surface:
//   getVendor(slug): Promise<VendorContract>                 GET  /v1/vendors/{slug}        (public)
//   search(query, opts?): Promise<VendorSearchResult[]>      POST /v1/search                (agent key)
//   pay(slug, args): Promise<PayResult>                      POST /v1/pay/{slug}            (agent key)
//       args: { input?: object; query?: object; maxCharge: PerfloMoney; idempotencyKey: string; signal?: AbortSignal }
//   getTransaction(id): Promise<Transaction>                 GET  /v1/transactions/{id}     (agent key)
//   listTransactions(opts?): Promise<Transaction[]>          GET  /v1/transactions          (agent key)
//   getBalance(): Promise<unknown>                           GET  /v1/balance               (startup smoke test)
// Also: a FixturePerfloClient with the same interface that serves test/fixtures when FIXTURE_MODE=true.
import type { PayResult, PerfloMoney, Transaction, VendorContract, VendorSearchResult } from "./types.js";

export interface PayArgs {
  readonly input?: Record<string, unknown>;
  readonly query?: Record<string, unknown>;
  readonly maxCharge: PerfloMoney;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

export interface PerfloClient {
  getVendor(slug: string): Promise<VendorContract>;
  search(query: string, opts?: { readonly capability?: string; readonly limit?: number }): Promise<VendorSearchResult[]>;
  pay(slug: string, args: PayArgs): Promise<PayResult>;
  getTransaction(id: string): Promise<Transaction>;
  listTransactions(opts?: { readonly limit?: number }): Promise<Transaction[]>;
  getBalance(): Promise<unknown>;
}

export interface PerfloClientOptions {
  readonly baseUrl: string;
  readonly agentKey: string;
  readonly timeoutMs: number;
}

export function createPerfloClient(_opts: PerfloClientOptions): PerfloClient {
  throw new Error("TODO(M2): implement createPerfloClient per PRD.md section 10");
}

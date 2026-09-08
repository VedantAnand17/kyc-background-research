// Perflo v1 API shapes we depend on. Adapted from perflo-quickstart/src/perflo.ts.
// Reference: https://pay-per-use-api.perflo.ai/llms.txt. PRD.md section 10.

export interface PerfloMoney {
  readonly amount: string;
  readonly currency: string;
}

/** One field of a vendor's request contract. `in` says where it goes: body -> `input`, query -> `query`. */
export interface VendorField {
  readonly name: string;
  readonly in: "body" | "query";
  readonly required: boolean;
  readonly type?: string;
  readonly description?: string;
  readonly autoFilled?: boolean;
}

/** GET /v1/vendors/{slug}. Budget against maxChargePerCall, never price. */
export interface VendorContract {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly capability: string;
  readonly price: PerfloMoney;
  readonly maxChargePerCall: PerfloMoney;
  readonly pricingUnit: "call" | "item";
  readonly latencyMsP50?: number;
  readonly payable: boolean;
  readonly unpayableReason?: string;
  readonly schemaConfidence?: "high" | "medium" | "low" | null;
  readonly input?: { readonly fields: readonly VendorField[]; readonly example?: unknown };
}

/** One row of POST /v1/search. Same money semantics as VendorContract. */
export interface VendorSearchResult {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly capability: string;
  readonly price: PerfloMoney;
  readonly maxChargePerCall: PerfloMoney;
  readonly pricingUnit: "call" | "item";
  readonly latencyMsP50?: number;
  readonly isPrimary: boolean;
  readonly payable: boolean;
  readonly unpayableReason?: string;
}

/** POST /v1/pay/{slug} 200 body. status "failed" is still a charge. */
export interface PayResult {
  readonly transactionId: string;
  readonly slug: string;
  readonly status: "succeeded" | "failed" | string;
  readonly terminal: boolean;
  readonly charged: PerfloMoney;
  readonly chargeIsFinal: boolean;
  readonly chargedTo: "credit" | "wallet" | null;
  readonly remaining: PerfloMoney;
  readonly output?: unknown;
  readonly failure?: { readonly reason?: string; readonly message?: string };
  readonly upstream?: { readonly httpStatus?: number };
  /**
   * How the charge settled. Observed 2026-09-08 on the funded account: `finalized` means `charged` is what the
   * budget paid; `not_required` (per-item Apify actors) means the account was debited the full authorization,
   * `maxCharge`, and `charged` is only the vendor's metered figure. GET /v1/key `spent` confirms the former.
   */
  readonly settlement?: { readonly status?: string; readonly flow?: string; readonly chain?: string | null };
}

/** GET /v1/transactions and GET /v1/transactions/{id}. amount is signed: negative leaves the account. */
export interface Transaction {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly ledgerState: "pending" | "posted" | "voided";
  readonly terminal?: boolean;
  readonly slug: string | null;
  readonly capability?: string;
  readonly amount: PerfloMoney;
  readonly createdAt: string;
  readonly idempotencyKey?: string;
}

/** Every error code PRD.md section 10 gives a behavior. Match on code, never on message. */
export type PerfloErrorCode =
  | "UNAUTHENTICATED"
  | "INVALID_REQUEST"
  | "VALIDATION_ERROR"
  | "SCHEMA_VALIDATION_FAILED"
  | "MAX_CHARGE_EXCEEDED"
  | "VENDOR_NOT_PAYABLE"
  | "VENDOR_NOT_FOUND"
  | "GUARDRAIL_DENIED"
  | "INSUFFICIENT_BALANCE"
  | "VENDOR_ERROR"
  | "SETTLEMENT_RECORDING_FAILED"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "UNKNOWN_CAPABILITY"
  | "TRANSACTION_NOT_FOUND"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | (string & {});

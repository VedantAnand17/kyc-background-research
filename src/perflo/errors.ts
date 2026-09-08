import type { PerfloErrorCode } from "./types.js";

/** A failure returned by Perflo, or a transport failure reaching it. Branch on `code`, never on `message`. */
export class PerfloError extends Error {
  constructor(
    readonly code: PerfloErrorCode,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> | undefined,
    readonly requestId: string | undefined,
  ) {
    super(message);
    this.name = "PerfloError";
  }
}

/** What the Spend Guard must do after a failed pay call. PRD.md section 10 table. */
export type LedgerAction = "settle" | "release" | "hold" | "settle_at_reserved";

export function ledgerActionFor(code: PerfloErrorCode): LedgerAction {
  switch (code) {
    case "SETTLEMENT_RECORDING_FAILED":
      return "settle_at_reserved";
    case "NETWORK_ERROR":
    case "TIMEOUT":
    case "INTERNAL_ERROR":
      return "hold";
    default:
      return "release";
  }
}

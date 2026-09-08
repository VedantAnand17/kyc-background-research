import { describe, expect, it } from "vitest";
import { ledgerActionFor } from "../src/perflo/errors.js";

// PRD.md section 10. The full client tests arrive in M2 with test/fake-perflo.ts.
describe("perflo error code -> ledger action", () => {
  it("maps the documented codes", () => {
    expect(ledgerActionFor("MAX_CHARGE_EXCEEDED")).toBe("release");
    expect(ledgerActionFor("SCHEMA_VALIDATION_FAILED")).toBe("release");
    expect(ledgerActionFor("VENDOR_NOT_PAYABLE")).toBe("release");
    expect(ledgerActionFor("GUARDRAIL_DENIED")).toBe("release");
    expect(ledgerActionFor("INSUFFICIENT_BALANCE")).toBe("release");
    expect(ledgerActionFor("VENDOR_ERROR")).toBe("release");
    expect(ledgerActionFor("RATE_LIMITED")).toBe("release");
    expect(ledgerActionFor("SETTLEMENT_RECORDING_FAILED")).toBe("settle_at_reserved");
    expect(ledgerActionFor("TIMEOUT")).toBe("hold");
    expect(ledgerActionFor("NETWORK_ERROR")).toBe("hold");
    expect(ledgerActionFor("INTERNAL_ERROR")).toBe("hold");
  });

  it.todo("pay() sends Idempotency-Key and maxCharge on every call");
  it.todo("a 200 with status failed is treated as a charge");
  it.todo("a timeout never re-pays; it looks the transaction up");
});

// In-process fake of the Perflo v1 API for tests. PRD.md section 16.
//
// TODO(M2): implement with Hono on an ephemeral port (or as a PerfloClient double).
// It must be able to answer every row of the PRD.md section 10 table on demand:
//   200 succeeded, 200 failed (charged), 422 MAX_CHARGE_EXCEEDED, 422 SCHEMA_VALIDATION_FAILED,
//   403 VENDOR_NOT_PAYABLE, 404 VENDOR_NOT_FOUND, 403 GUARDRAIL_DENIED, 402 INSUFFICIENT_BALANCE,
//   502 VENDOR_ERROR, 202 pending_confirmation, 500 SETTLEMENT_RECORDING_FAILED, 429 RATE_LIMITED,
//   and a hang that triggers the client timeout.
// It must honor Idempotency-Key: a repeated key returns the first result and charges once.

export function startFakePerflo(): never {
  throw new Error("TODO(M2): implement startFakePerflo per PRD.md section 16");
}

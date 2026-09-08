import { describe, it } from "vitest";

// PRD.md sections 5.4 and 16. Implement in M6 alongside src/evidence/report.ts and src/api/schemas.ts.
describe("report invariants", () => {
  it.todo("costs.total equals the sum of calls and the ledger, and never exceeds budget");
  it.todo("every sourceIds entry references a listed source");
  it.todo("profile is empty when identity is ambiguous or not_found, with a warning");
  it.todo("risk.overall.level is unknown when identity is ambiguous or not_found");
  it.todo("amounts are formatted with six fractional digits");
  it.todo("a report that fails the schema is rejected loudly");
});

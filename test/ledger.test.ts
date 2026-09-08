import { describe, it } from "vitest";

// PRD.md section 16. Implement in M2 alongside src/budget/ledger.ts.
describe("spend guard", () => {
  it.todo("denies a reservation when cap - spent - reserved < amount");
  it.todo("N concurrent reservations of random amounts never exceed the cap (property test)");
  it.todo("settle moves reserved to spent at the charged amount, including status failed");
  it.todo("release returns the reservation to headroom");
  it.todo("hold then resolveHold settles or releases from the transaction lookup");
  it.todo("persists every transition to the ledger table before returning");
});

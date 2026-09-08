import { describe, it } from "vitest";

// PRD.md section 16. Fixture-mode end-to-end. Implement in M5.
describe("orchestrator (fixture mode)", () => {
  it.todo("basic tier request produces a valid report under the cap");
  it.todo("standard tier request produces a valid report under the cap");
  it.todo("deep tier request produces a valid report under the cap");
  it.todo("deadline hit cuts phases and still produces a report with timing.deadlineHit");
  it.todo("budget exhausted mid-enrich finishes with warnings and total <= cap");
  it.todo("ambiguous identity yields empty profile and overall risk unknown");
});

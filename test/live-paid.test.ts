// M7 live verification against funded Perflo. Skipped until PERFLO_AGENT_KEY is set.
// Do not enable this to spend money until the live-model and failure-injection suites are green.
import { describe, expect, it } from "vitest";
import { livePerfloKey } from "./live-env.js";

const funded = Boolean(livePerfloKey());

describe.skipIf(!funded)("M7 funded Perflo verification", () => {
  it("records three real subjects at three tiers whose ledger totals match GET /v1/transactions", () => {
    expect.fail("M7 runner is not wired yet; record fixtures from the funded runs first.");
  });

  it("refuses a $0.05 cap without exceeding it", () => {
    expect.fail("M7 runner is not wired yet.");
  });

  it("returns not_found for a nonexistent person", () => {
    expect.fail("M7 runner is not wired yet.");
  });
});

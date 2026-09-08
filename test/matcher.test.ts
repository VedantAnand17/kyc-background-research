import { describe, it } from "vitest";

// PRD.md sections 8 and 16. Implement in M4 alongside src/identity/matcher.ts.
describe("identity matcher", () => {
  it.todo("exact normalized name + DOB + location scores confirmed");
  it.todo("nickname match scores 0.9 on the name signal");
  it.todo("same name in another city is labeled possible and never primary");
  it.todo("a DOB conflict caps the total at 0.30");
  it.todo("missing DOB in the request renormalizes weights and caps at 0.85 with a warning");
  it.todo("corroboration across two independent sources adds the bonus");
  it.todo("two candidates within 0.15 yield status ambiguous");
});

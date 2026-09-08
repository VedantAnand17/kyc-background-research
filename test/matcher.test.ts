import { describe, expect, it } from "vitest";
import { decideIdentity } from "../src/identity/matcher.js";
import {
  ambiguousGap,
  corroborationBonus,
  dobConflict,
  exactMatch,
  missingDob,
  nicknameMatch,
  sameNameOtherCity,
} from "./fixtures/identity.js";

describe("identity matcher", () => {
  it("exact normalized name + DOB + location scores confirmed", () => {
    const decision = decideIdentity(exactMatch.subject, exactMatch.candidates);
    expect(decision.status).toBe("confirmed");
    expect(decision.primaryCandidateId).toBe("c1");
    expect(decision.candidates).toHaveLength(1);
    const [top] = decision.candidates;
    expect(top?.confidence).toBeCloseTo(0.8, 4);
    expect(top?.label).toBe("confirmed");
    expect(top?.matchedOn).toEqual(["name", "dob", "location"]);
    expect(top?.conflicts).toEqual([]);
  });

  it("nickname match scores 0.9 on the name signal", () => {
    const decision = decideIdentity(nicknameMatch.subject, nicknameMatch.candidates);
    const [top] = decision.candidates;
    // 0.35 * 0.9 + 0.25 + 0.20 = 0.765, probable, still primary with no runner-up.
    expect(top?.confidence).toBeCloseTo(0.765, 4);
    expect(top?.label).toBe("probable");
    expect(top?.matchedOn).toContain("name");
    expect(decision.status).toBe("probable");
    expect(decision.primaryCandidateId).toBe("c1");
  });

  it("same name in another city is labeled possible and never primary", () => {
    const decision = decideIdentity(sameNameOtherCity.subject, sameNameOtherCity.candidates);
    const other = decision.candidates.find((c) => c.id === "c2");
    expect(other?.label).toBe("possible");
    expect(other?.confidence).toBeCloseTo(0.3, 4);
    expect(other?.conflicts).toContain("location");
    expect(decision.primaryCandidateId).toBe("c1");
    expect(decision.primaryCandidateId).not.toBe("c2");
  });

  it("a DOB conflict caps the total at 0.30", () => {
    const decision = decideIdentity(dobConflict.subject, dobConflict.candidates);
    const [top] = decision.candidates;
    // Name + location + corroboration would be 0.75 without the cap.
    expect(top?.confidence).toBeCloseTo(0.3, 4);
    expect(top?.confidence).toBeLessThanOrEqual(0.3);
    expect(top?.label).toBe("possible");
    expect(top?.conflicts).toContain("dob");
  });

  it("missing DOB in the request renormalizes weights and caps at 0.85 with a warning", () => {
    const decision = decideIdentity(missingDob.subject, missingDob.candidates);
    const [top] = decision.candidates;
    expect(top?.confidence).toBeCloseTo(0.85, 4);
    expect(top?.confidence).toBeLessThanOrEqual(0.85);
    expect(top?.label).toBe("confirmed");
    expect(decision.warnings.some((w) => /date of birth/i.test(w))).toBe(true);
  });

  it("corroboration across two independent sources adds the bonus", () => {
    const withBonus = decideIdentity(corroborationBonus.subject, corroborationBonus.candidates);
    const without = decideIdentity(exactMatch.subject, exactMatch.candidates);
    expect(withBonus.candidates[0]?.matchedOn).toContain("corroboration");
    expect(withBonus.candidates[0]?.confidence).toBeCloseTo(1, 4);
    expect(without.candidates[0]?.confidence).toBeCloseTo(0.8, 4);
    expect(withBonus.candidates[0]!.confidence - without.candidates[0]!.confidence).toBeCloseTo(0.2, 4);
  });

  it("two candidates within 0.15 yield status ambiguous", () => {
    const decision = decideIdentity(ambiguousGap.subject, ambiguousGap.candidates);
    expect(decision.candidates).toHaveLength(2);
    const [lead, runner] = [...decision.candidates].sort((a, b) => b.confidence - a.confidence);
    expect(lead!.confidence - runner!.confidence).toBeLessThan(0.15);
    expect(lead!.label === "probable" || lead!.label === "possible").toBe(true);
    expect(decision.status).toBe("ambiguous");
    expect(decision.primaryCandidateId).toBeNull();
  });
});

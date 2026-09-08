import { describe, expect, it } from "vitest";
import {
  adverseMediaQuery,
  agentSystemPrompt,
  disambiguationPrompt,
  narrativePrompt,
} from "../src/research/prompts.js";

const base = {
  subject: "Ada Okonkwo, born 1991-04-12, Lagos NG",
  tier: "standard",
  remainingBudget: "1.350000",
  allowedTools: ["find_people", "search_news", "finish"],
};

describe("prompts", () => {
  it("states the subject, tier, remaining budget, allowed tools, and no-invention rule", () => {
    const text = agentSystemPrompt(base);
    expect(text).toContain("Ada Okonkwo");
    expect(text).toContain("standard");
    expect(text).toContain("1.350000");
    expect(text).toContain("find_people");
    expect(text).toMatch(/never invent/i);
  });

  it("asks the model to pick one discriminator for the two closest candidates", () => {
    const text = disambiguationPrompt({
      ...base,
      lead: "c1 Ada Okonkwo Lagos 0.60",
      runner: "c2 Ada Okonkwo Nairobi 0.55",
    });
    expect(text).toContain("c1");
    expect(text).toContain("c2");
    expect(text).toMatch(/one allowed tool/i);
  });

  it("restricts the narrative pass to the three fields code does not own", () => {
    const text = narrativePrompt(base);
    expect(text).toMatch(/summary/i);
    expect(text).toMatch(/rationale/i);
    expect(text).toMatch(/never invent/i);
  });

  it("builds the fixed adverse-media query from the subject name", () => {
    expect(adverseMediaQuery("Ada Okonkwo")).toBe(
      '"Ada Okonkwo" fraud OR scam OR arrested OR indicted OR lawsuit OR sanctions',
    );
  });
});

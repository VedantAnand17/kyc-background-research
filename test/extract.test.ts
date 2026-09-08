import { describe, expect, it } from "vitest";
import { extractFor, SUMMARY_MAX_CHARS } from "../src/evidence/extract.js";
import type { ToolName } from "../src/research/capabilities.js";

const TOOLS: readonly Exclude<ToolName, "finish">[] = [
  "find_people",
  "get_professional_profile",
  "search_news",
  "screen_watchlist",
  "enrich_person",
  "get_social_profile",
  "search_web",
  "skip_trace",
  "search_filings",
  "fetch_page",
];

describe("extractors", () => {
  it("has one extractor per capability and never exceeds 1500 characters", () => {
    const raw = {
      people: [{ name: "Ada Okonkwo", location: "Lagos" }],
      headline: "Product lead",
      articles: [{ title: "Ada joins Paystack", outlet: "TechCabal" }],
      hits: [],
      emails: ["ada@example.com"],
      handle: "ada",
      results: [{ title: "Ada Okonkwo", url: "https://example.com" }],
      addresses: ["12 Marina Rd"],
      filings: [{ title: "Form 4" }],
      markdown: "page text",
    };
    for (const tool of TOOLS) {
      const out = extractFor(tool, raw);
      expect(out.summary.length, tool).toBeGreaterThan(0);
      expect(out.summary.length, tool).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
      expect(out.facts).toBeDefined();
    }
  });

  it("clips an oversized summary at 1500 characters", () => {
    const out = extractFor("fetch_page", { markdown: "x".repeat(5000) });
    expect(out.summary).toHaveLength(SUMMARY_MAX_CHARS);
  });

  it("pulls candidate names from find_people payloads", () => {
    const out = extractFor("find_people", {
      people: [
        { name: "Ada Okonkwo", location: "Lagos" },
        { fullName: "Ada O.", city: "Abuja" },
      ],
    });
    expect(out.summary).toContain("Ada Okonkwo");
    expect(out.candidateEvidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Ada Okonkwo" })]),
    );
  });
});

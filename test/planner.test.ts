import { describe, expect, it } from "vitest";
import { parseMoney } from "../src/budget/money.js";
import { defaultDeadlineMs, plan } from "../src/research/planner.js";

describe("plan", () => {
  it("maps a cap under $0.50 to basic tools and a 10 percent reserve", () => {
    const cap = parseMoney("0.49");
    const result = plan(cap, 45_000, 1_000);
    expect(result.tier).toBe("basic");
    expect(result.allowedTools).toEqual([
      "find_people",
      "get_professional_profile",
      "search_news",
      "screen_watchlist",
      "finish",
    ]);
    expect(result.capMicro).toBe(cap);
    expect(result.reserveMicro).toBe(49_000n);
    expect(result.deadlineAt).toBe(46_000);
  });

  it("maps $0.50 and $2.00 inclusive to standard", () => {
    expect(plan(parseMoney("0.50"), 10_000, 0).tier).toBe("standard");
    expect(plan(parseMoney("2.00"), 10_000, 0).tier).toBe("standard");
    expect(plan(parseMoney("0.50"), 10_000, 0).allowedTools).toEqual([
      "find_people",
      "get_professional_profile",
      "search_news",
      "screen_watchlist",
      "enrich_person",
      "get_social_profile",
      "search_web",
      "finish",
    ]);
  });

  it("maps a cap above $2.00 to deep, including skip_trace and fetch_page", () => {
    const result = plan(parseMoney("2.000001"), 8_000, 100);
    expect(result.tier).toBe("deep");
    expect(result.allowedTools).toContain("skip_trace");
    expect(result.allowedTools).toContain("search_filings");
    expect(result.allowedTools).toContain("fetch_page");
    expect(result.deadlineAt).toBe(8_100);
  });

  it("ceils the reserve to the next micro-dollar", () => {
    expect(plan(1_000_001n, 5_000, 0).reserveMicro).toBe(100_001n);
  });

  it("defaults the deadline to 60s, or 90s for deep", () => {
    expect(defaultDeadlineMs(parseMoney("1.50"))).toBe(60_000);
    expect(defaultDeadlineMs(parseMoney("2.00"))).toBe(60_000);
    expect(defaultDeadlineMs(parseMoney("2.01"))).toBe(90_000);
  });
});

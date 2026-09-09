import { describe, expect, it } from "vitest";
import { parseMoney } from "../src/budget/money.js";
import { defaultDeadlineMs, discriminatorTools, plan, reserveFromQuotes } from "../src/research/planner.js";

describe("reserveFromQuotes", () => {
  it("holds back the cheapest discriminator quote", () => {
    expect(reserveFromQuotes(1_000_000n, 50_000n, 25_200n)).toBe(25_200n);
  });

  it("never holds so much that find_people cannot run", () => {
    expect(reserveFromQuotes(80_000n, 50_000n, 50_000n)).toBe(30_000n);
  });

  it("holds nothing when find_people itself does not fit the cap", () => {
    expect(reserveFromQuotes(40_000n, 50_000n, 25_200n)).toBe(0n);
  });

  it("holds nothing when no discriminator is payable", () => {
    expect(reserveFromQuotes(1_000_000n, 50_000n, null)).toBe(0n);
  });
});

describe("discriminatorTools", () => {
  it("drops resolve, finish, and watchlist so the reserve is sized for a separator", () => {
    expect(
      discriminatorTools([
        "find_people",
        "get_professional_profile",
        "search_news",
        "screen_watchlist",
        "finish",
      ]),
    ).toEqual(["get_professional_profile", "search_news"]);
  });
});

describe("plan", () => {
  it("maps a cap under $0.50 to basic tools and the quote-sized reserve", () => {
    const cap = parseMoney("0.49");
    const result = plan(cap, 45_000, 1_000, 25_200n);
    expect(result.tier).toBe("basic");
    expect(result.allowedTools).toEqual([
      "find_people",
      "get_professional_profile",
      "search_news",
      "screen_watchlist",
      "finish",
    ]);
    expect(result.capMicro).toBe(cap);
    expect(result.reserveMicro).toBe(25_200n);
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

  it("rejects a reserve larger than the cap", () => {
    expect(() => plan(100n, 5_000, 0, 101n)).toThrow(RangeError);
  });

  it("defaults the deadline by tier: 90s basic, 120s standard and deep", () => {
    expect(defaultDeadlineMs(parseMoney("0.30"))).toBe(90_000);
    expect(defaultDeadlineMs(parseMoney("1.50"))).toBe(120_000);
    expect(defaultDeadlineMs(parseMoney("2.01"))).toBe(120_000);
  });
});

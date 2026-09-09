import { describe, expect, it } from "vitest";
import { ceilFraction, formatMoney, parseMoney, toMoney } from "../src/budget/money.js";

describe("money", () => {
  it("parses Perflo decimal strings exactly", () => {
    expect(parseMoney("0.0252")).toBe(25_200n);
    expect(parseMoney("1.50")).toBe(1_500_000n);
    expect(parseMoney("0.001")).toBe(1_000n);
    expect(parseMoney("12")).toBe(12_000_000n);
    expect(parseMoney("0.000001")).toBe(1n);
  });

  it("rejects malformed amounts", () => {
    for (const bad of ["", "1.", ".5", "-1", "1e3", "1,000", "0.0000001", "abc", " 1"]) {
      expect(() => parseMoney(bad), bad).toThrow(RangeError);
    }
  });

  it("formats with exactly six fractional digits", () => {
    expect(formatMoney(0n)).toBe("0.000000");
    expect(formatMoney(25_200n)).toBe("0.025200");
    expect(formatMoney(1_120_000n)).toBe("1.120000");
    expect(formatMoney(1_000_000_000_000n)).toBe("1000000.000000");
  });

  it("round-trips", () => {
    for (const s of ["0.000000", "0.025200", "1.500000", "999.999999"]) {
      expect(formatMoney(parseMoney(s))).toBe(s);
    }
  });

  it("never produces a negative amount", () => {
    expect(() => formatMoney(-1n)).toThrow(RangeError);
  });

  it("builds a Money object", () => {
    expect(toMoney(1_500_000n)).toEqual({ amount: "1.500000", currency: "USD" });
  });

  it("ceils fractions", () => {
    expect(ceilFraction(1_500_000n, 1n, 10n)).toBe(150_000n);
    expect(ceilFraction(1n, 1n, 10n)).toBe(1n);
    expect(ceilFraction(0n, 1n, 10n)).toBe(0n);
  });
});

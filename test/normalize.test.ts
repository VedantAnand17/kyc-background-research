import { describe, expect, it } from "vitest";
import { jaroWinkler, nameSimilarity, normalizeName } from "../src/identity/normalize.js";

describe("normalizeName", () => {
  it("strips diacritics, punctuation, extra space, suffixes, and middle names", () => {
    expect(normalizeName("José  Okonkwo Jr.")).toBe("jose okonkwo");
    expect(normalizeName("ADA   MARIE   OKONKWO")).toBe("ada okonkwo");
    expect(normalizeName("William Henry Gates III")).toBe("william gates");
    expect(normalizeName("O'Brien")).toBe("obrien");
  });
});

describe("jaroWinkler", () => {
  it("matches the standard MARTHA/MARHTA example", () => {
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.9611, 4);
  });

  it("returns 1 for identical strings and 0 when either is empty", () => {
    expect(jaroWinkler("ada okonkwo", "ada okonkwo")).toBe(1);
    expect(jaroWinkler("", "ada")).toBe(0);
    expect(jaroWinkler("ada", "")).toBe(0);
  });
});

describe("nameSimilarity", () => {
  it("scores a known nickname at 0.9 when last names match", () => {
    expect(nameSimilarity("William Okonkwo", "Bill Okonkwo")).toBe(0.9);
    expect(nameSimilarity("Bill Okonkwo", "William Okonkwo")).toBe(0.9);
  });

  it("scores a normalized exact name at 1.0", () => {
    expect(nameSimilarity("Ada Okonkwo", "ada okonkwo")).toBe(1);
    expect(nameSimilarity("José Okonkwo Jr.", "Jose Okonkwo")).toBe(1);
  });
});

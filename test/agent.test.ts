import { describe, expect, it } from "vitest";
import { extractJsonObject } from "../src/research/agent.js";

describe("extractJsonObject", () => {
  it("parses a bare object", () => {
    expect(extractJsonObject('{"hits":[]}')).toEqual({ hits: [] });
  });

  it("strips a markdown fence and leading prose", () => {
    expect(extractJsonObject('Here you go:\n```json\n{"rationale":"clear"}\n```')).toEqual({
      rationale: "clear",
    });
  });

  it("throws when no object is present", () => {
    expect(() => extractJsonObject("narrative unavailable")).toThrow(/json object/i);
  });
});

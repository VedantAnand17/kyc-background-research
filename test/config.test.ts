import { describe, expect, it } from "vitest";
import { loadConfig, loopModelName } from "../src/config.js";

const base = {
  LLM_API_KEY: "test-key",
  FIXTURE_MODE: "true",
};

describe("loop model", () => {
  it("defaults the tool loop to LLM_MODEL", () => {
    const config = loadConfig({
      ...base,
      LLM_PROVIDER: "cloudflare",
      CLOUDFLARE_ACCOUNT_ID: "d5addfff98319ee236259e234106087d",
    });
    expect(config.LLM_MODEL).toBe("@cf/zai-org/glm-5.3");
    expect(loopModelName(config)).toBe("@cf/zai-org/glm-5.3");
  });

  it("honors an explicit LLM_LOOP_MODEL", () => {
    const config = loadConfig({
      ...base,
      LLM_PROVIDER: "openai-compatible",
      LLM_BASE_URL: "http://127.0.0.1:9",
      LLM_MODEL: "narrative-model",
      LLM_LOOP_MODEL: "loop-model",
    });
    expect(loopModelName(config)).toBe("loop-model");
  });

  it("defaults the operator deadline override to 90 seconds", () => {
    const config = loadConfig({
      ...base,
      LLM_PROVIDER: "openai-compatible",
      LLM_BASE_URL: "http://127.0.0.1:9",
    });
    expect(config.RESEARCH_DEADLINE_MS).toBe(90_000);
    expect(config.LLM_REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it("reuses LLM_MODEL for the loop on non-Cloudflare providers", () => {
    const config = loadConfig({
      ...base,
      LLM_PROVIDER: "openai-compatible",
      LLM_BASE_URL: "http://127.0.0.1:9",
      LLM_MODEL: "local-model",
    });
    expect(loopModelName(config)).toBe("local-model");
  });
});

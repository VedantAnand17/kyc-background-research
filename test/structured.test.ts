import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import {
  chatCompletionsUrl,
  extractJsonObject,
  generateStructured,
  structuredRequestBody,
} from "../src/research/structured.js";

const Schema = z.object({
  rationale: z.string(),
  hits: z.array(z.object({ sourceId: z.string(), aboutPrimary: z.boolean() })),
});

const config = loadConfig({
  LLM_API_KEY: "test-key",
  FIXTURE_MODE: "true",
  LLM_PROVIDER: "cloudflare",
  CLOUDFLARE_ACCOUNT_ID: "d5addfff98319ee236259e234106087d",
});

describe("structured output request", () => {
  it("sends response_format json_schema on the Cloudflare chat completions URL", async () => {
    const seen: { url: string; body: Record<string, unknown>; auth: string } = { url: "", body: {}, auth: "" };
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      seen.url = String(url);
      seen.auth = new Headers(init?.headers).get("authorization") ?? "";
      seen.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"rationale":"clear","hits":[{"sourceId":"s1","aboutPrimary":false}]}' } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const object = await generateStructured(Schema, {
      config,
      model: "@cf/zai-org/glm-5.3",
      system: "Classify only the listed hits.",
      prompt: "s1: Houston fine",
      name: "classification",
      fetchImpl,
    });

    expect(seen.url).toBe(chatCompletionsUrl(config));
    expect(seen.url).toMatch(/\/ai\/v1\/chat\/completions$/);
    expect(seen.auth).toBe("Bearer test-key");
    expect(seen.body?.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "classification",
        schema: expect.objectContaining({ type: "object" }),
      },
    });
    expect(seen.body?.reasoning_effort).toBe("low");
    expect((seen.body?.response_format as { json_schema: { schema: { additionalProperties?: unknown } } }).json_schema.schema.additionalProperties).toBeUndefined();
    expect(object).toEqual({ rationale: "clear", hits: [{ sourceId: "s1", aboutPrimary: false }] });
  });

  it("includes reasoning_effort only when asked", () => {
    const withEffort = structuredRequestBody(Schema, {
      model: "@cf/openai/gpt-oss-120b",
      system: "x",
      prompt: "y",
      name: "narrative",
      reasoningEffort: "low",
    });
    const glm = structuredRequestBody(Schema, {
      model: "@cf/zai-org/glm-5.3",
      system: "x",
      prompt: "y",
      name: "narrative",
    });
    expect(withEffort.reasoning_effort).toBe("low");
    expect(glm.reasoning_effort).toBe("low");
  });

  it("rejects an empty model content so callers can warn instead of guessing", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }] }), {
        status: 200,
      });
    });
    await expect(
      generateStructured(Schema, {
        config,
        model: "@cf/zai-org/glm-5.3",
        system: "x",
        prompt: "y",
        name: "narrative",
        fetchImpl,
      }),
    ).rejects.toThrow(/empty model content/i);
  });
});

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

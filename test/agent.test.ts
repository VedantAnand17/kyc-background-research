import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig } from "../src/config.js";
import { createAgent, extractJsonObject, loopProviderOptions, toolCallsAccepted } from "../src/research/agent.js";
import type { ResearchTools, ToolOutcome } from "../src/research/tools.js";
import { z } from "zod";

describe("tool loop request", () => {
  it("sends reasoning_effort low for glm and gpt-oss, nothing for other models", () => {
    expect(loopProviderOptions("@cf/zai-org/glm-5.3")).toEqual({ openaiCompatible: { reasoningEffort: "low" } });
    expect(loopProviderOptions("@cf/openai/gpt-oss-120b")).toEqual({ openaiCompatible: { reasoningEffort: "low" } });
    expect(loopProviderOptions("gpt-4.1")).toBeUndefined();
  });

  it("keeps looping after a rejected call and stops once a turn's calls are accepted", () => {
    const step = (calls: Array<{ name: string; outcome?: string }>) => ({
      toolCalls: calls.map((row) => ({ toolName: row.name })),
      toolResults: calls.map((row) => ({ toolName: row.name, output: row.outcome ? { outcome: row.outcome } : undefined })),
    });
    const steps = (...rows: ReturnType<typeof step>[]) => ({ steps: rows as never });
    expect(toolCallsAccepted(steps(step([])))).toBe(false);
    expect(toolCallsAccepted(steps(step([{ name: "find_people", outcome: "invalid_args" }])))).toBe(false);
    expect(toolCallsAccepted(steps(step([{ name: "find_people", outcome: "ok" }])))).toBe(true);
    expect(
      toolCallsAccepted(steps(step([{ name: "enrich_person", outcome: "ok" }, { name: "search_news", outcome: "budget_exhausted" }]))),
    ).toBe(true);
  });

  it("stops the loop after one accepted tool turn, repairs invalid args, and sends low effort on the wire", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const app = new Hono();
    app.post("/chat/completions", async (c) => {
      const body = (await c.req.json()) as Record<string, unknown>;
      bodies.push(body);
      const call =
        bodies.length === 1
          ? { name: "find_people", args: { name: "Ada Okonkwo" } }
          : { name: "find_people", args: { fullName: "Ada Okonkwo" } };
      return c.json({
        id: `chatcmpl-${bodies.length}`,
        object: "chat.completion",
        created: 0,
        model: "@cf/zai-org/glm-5.3",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ id: `call-${bodies.length}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
    const server = createServer(getRequestListener(app.fetch));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("bind failed");
    try {
      const config = loadConfig({
        FIXTURE_MODE: "true",
        LLM_PROVIDER: "openai-compatible",
        LLM_BASE_URL: `http://127.0.0.1:${addr.port}`,
        LLM_API_KEY: "test",
        LLM_MODEL: "@cf/zai-org/glm-5.3",
        LOG_LEVEL: "error",
      });
      const execute = vi.fn(async (): Promise<ToolOutcome> => ({ outcome: "ok", sourceId: "s1", summary: "one", charged: "0.010000", remaining: "0.390000", cached: false }));
      const tools: ResearchTools = {
        find_people: { description: "find", inputSchema: z.object({ fullName: z.string() }), execute },
        finish: { description: "done", inputSchema: z.object({}), execute: async () => ({ outcome: "ok", sourceId: "", summary: "done", charged: "0.000000", remaining: "0.390000", cached: true }) },
      };
      await createAgent(config).resolve({
        subject: { firstName: "Ada", lastName: "Okonkwo" },
        tier: "basic",
        remainingBudget: "0.400000",
        allowedTools: ["find_people", "finish"],
        tools,
        signal: new AbortController().signal,
      });
      // Turn 1 is rejected by the tool schema (no fullName), turn 2 is accepted, and no finish turn follows.
      expect(bodies).toHaveLength(2);
      // The model is shown the real argument schema, not a loose record.
      const advertised = (bodies[0]!.tools as Array<{ function: { name: string; parameters: { properties?: Record<string, unknown>; required?: string[] } } }>)
        .find((row) => row.function.name === "find_people")!.function.parameters;
      expect(Object.keys(advertised.properties ?? {})).toEqual(["fullName"]);
      expect(advertised.required).toEqual(["fullName"]);
      expect(bodies.every((b) => b.reasoning_effort === "low")).toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
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

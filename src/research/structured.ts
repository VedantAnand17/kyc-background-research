// Constrained structured output via the OpenAI-compatible chat completions API.
// The AI SDK openai-compatible provider drops response_format unless supportsStructuredOutputs
// is set, and even then glm-5.3 spends its token budget on reasoning and returns empty text.
// A raw request with response_format: json_schema is the path that returned valid JSON in 5.8 s.
import { z } from "zod";
import { llmBaseUrl, type Config } from "../config.js";

export interface StructuredInput {
  readonly config: Config;
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  readonly name: string;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly reasoningEffort?: string;
}

export function extractJsonObject(text: string): unknown {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/u, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no json object in model text");
  return JSON.parse(stripped.slice(start, end + 1));
}

export function chatCompletionsUrl(config: Config): string {
  if (config.LLM_PROVIDER === "openai") return "https://api.openai.com/v1/chat/completions";
  const base = llmBaseUrl(config);
  if (!base) throw new Error("LLM_BASE_URL is required for this provider");
  return `${base.replace(/\/$/, "")}/chat/completions`;
}

function stripAdditionalProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAdditionalProperties);
  if (!value || typeof value !== "object") return value;
  const rec = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(rec)) {
    if (key === "additionalProperties" || key === "$schema") continue;
    out[key] = stripAdditionalProperties(item);
  }
  return out;
}

export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  return stripAdditionalProperties(z.toJSONSchema(schema)) as Record<string, unknown>;
}

/** glm-5.3 thinking cannot be disabled; default effort is max and eats the token budget. */
export function structuredReasoningEffort(model: string): string | undefined {
  const name = model.toLowerCase();
  if (name.includes("glm") || name.includes("gpt-oss")) return "low";
  return undefined;
}

function contentOf(payload: unknown): string {
  const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part === "string" ? part : String((part as { text?: unknown }).text ?? "")))
      .join("");
    if (joined.trim()) return joined;
  }
  throw new Error("structured output: empty model content");
}

export function structuredRequestBody(
  schema: z.ZodType,
  input: Pick<StructuredInput, "model" | "system" | "prompt" | "name" | "reasoningEffort">,
): Record<string, unknown> {
  const effort = input.reasoningEffort ?? structuredReasoningEffort(input.model);
  const body: Record<string, unknown> = {
    model: input.model,
    max_tokens: 4000,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.prompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: input.name,
        schema: jsonSchemaOf(schema),
      },
    },
  };
  if (effort) body.reasoning_effort = effort;
  return body;
}

export async function generateStructured<T>(schema: z.ZodType<T>, input: StructuredInput): Promise<T> {
  const response = await (input.fetchImpl ?? fetch)(chatCompletionsUrl(input.config), {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.config.LLM_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(structuredRequestBody(schema, input)),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`structured output ${response.status}: ${text.slice(0, 300)}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("structured output: provider returned non-json");
  }
  const raw = contentOf(payload);
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    return schema.parse(extractJsonObject(raw));
  }
}

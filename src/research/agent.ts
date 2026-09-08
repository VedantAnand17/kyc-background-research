// Agent loop: Vercel AI SDK tool calling with a 12-step limit. PRD.md sections 6.2 to 6.5 and 11.
// The model decides which allowed tool to call next. It never writes an amount, never assigns a
// confidence score, and never sees raw vendor payloads (ADR-0001).
import { generateText, stepCountIs, tool, type ToolSet } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { llmBaseUrl, loopModelName, type Config } from "../config.js";
import type { ResearchTools } from "./tools.js";
import type { ToolName } from "./capabilities.js";
import {
  agentSystemPrompt,
  describeSubject,
  disambiguationPrompt,
  enrichUserPrompt,
  narrativePrompt,
  resolveUserPrompt,
  riskClassifyPrompt,
  type PromptFacts,
} from "./prompts.js";

export interface AgentSubject {
  readonly firstName: string;
  readonly lastName: string;
  readonly dateOfBirth?: string;
  readonly address?: { readonly city?: string; readonly region?: string; readonly country?: string };
}

export interface AgentContext {
  readonly subject: AgentSubject;
  readonly tier: string;
  readonly remainingBudget: string;
  readonly allowedTools: readonly ToolName[];
  readonly tools: ResearchTools;
  readonly signal: AbortSignal;
  readonly lead?: string;
  readonly runner?: string;
}

export interface RiskHit {
  readonly sourceId: string;
  readonly title: string;
}

export interface RiskClassification {
  readonly sourceId: string;
  readonly aboutPrimary: boolean;
  readonly severity: "low" | "medium" | "high";
  readonly summary: string;
  /** Headline used to attribute a news item to the primary candidate. */
  readonly title?: string;
}

export interface NarrativeFields {
  readonly candidateSummaries: Readonly<Record<string, string>>;
  readonly reputationalSummaries: Readonly<Record<string, string>>;
  readonly rationale: string;
}

export interface ResearchAgent {
  resolve(ctx: AgentContext): Promise<void>;
  disambiguate(ctx: AgentContext): Promise<void>;
  enrich(ctx: AgentContext): Promise<void>;
  classifyRisk(
    hits: readonly RiskHit[],
    signal?: AbortSignal,
  ): Promise<readonly RiskClassification[]> | readonly RiskClassification[];
  narrate(ctx: AgentContext & { readonly evidenceNotes: string }): Promise<NarrativeFields>;
}

function factsOf(ctx: AgentContext): PromptFacts {
  return {
    subject: describeSubject(ctx.subject),
    tier: ctx.tier,
    remainingBudget: ctx.remainingBudget,
    allowedTools: ctx.allowedTools,
  };
}

function sdkTools(tools: ResearchTools): ToolSet {
  const out: ToolSet = {};
  for (const [name, row] of Object.entries(tools)) {
    if (!row) continue;
    out[name] = tool({
      description: row.description,
      inputSchema: row.inputSchema,
      execute: async (args) => row.execute(args as Record<string, unknown>),
    }) as ToolSet[string];
  }
  return out;
}

function languageModel(config: Config, modelName = config.LLM_MODEL) {
  if (config.LLM_PROVIDER === "openai") {
    return createOpenAI({ apiKey: config.LLM_API_KEY })(modelName);
  }
  const baseURL = llmBaseUrl(config);
  if (!baseURL) throw new Error("LLM_BASE_URL is required for this provider");
  return createOpenAICompatible({
    name: config.LLM_PROVIDER,
    baseURL,
    apiKey: config.LLM_API_KEY,
  })(modelName);
}

function reasoningOptions(model: string): { openaiCompatible: { reasoningEffort: string } } | undefined {
  if (!model.includes("gpt-oss")) return undefined;
  return { openaiCompatible: { reasoningEffort: "low" } };
}

/** glm-5.3 json_schema mode spends the token budget on reasoning_content and returns empty content. */
export function extractJsonObject(text: string): unknown {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/u, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no json object in model text");
  return JSON.parse(stripped.slice(start, end + 1));
}

async function structuredObject<T>(
  schema: z.ZodType<T>,
  input: {
    readonly model: ReturnType<typeof languageModel>;
    readonly system: string;
    readonly prompt: string;
    readonly signal?: AbortSignal;
    readonly providerOptions?: { openaiCompatible: { reasoningEffort: string } };
  },
): Promise<T> {
  const result = await generateText({
    model: input.model,
    system: `${input.system}\nReply with one JSON object only. No markdown fence.`,
    prompt: input.prompt,
    maxOutputTokens: 1500,
    ...(input.signal ? { abortSignal: input.signal } : {}),
    ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
  });
  return schema.parse(extractJsonObject(result.text));
}

const ClassificationSchema = z.object({
  hits: z.array(
    z.object({
      sourceId: z.string(),
      aboutPrimary: z.boolean(),
      severity: z.enum(["low", "medium", "high"]),
      summary: z.string(),
    }),
  ),
});

const NarrativeSchema = z.object({
  candidateSummaries: z.array(z.object({ id: z.string(), summary: z.string() })),
  reputationalSummaries: z.array(z.object({ sourceId: z.string(), summary: z.string() })),
  rationale: z.string(),
});

const RESOLVE_STEPS = 4;
const DISAMBIGUATE_STEPS = 2;
const ENRICH_STEPS = 3;

export function createAgent(config: Config): ResearchAgent {
  const loopModel = languageModel(config, loopModelName(config));
  const narrativeModel = languageModel(config);
  const loopOptions = reasoningOptions(loopModelName(config));
  const narrativeOptions = reasoningOptions(config.LLM_MODEL);

  async function loop(ctx: AgentContext, system: string, prompt: string, steps: number): Promise<void> {
    if (ctx.signal.aborted) return;
    await generateText({
      model: loopModel,
      system,
      prompt,
      tools: sdkTools(ctx.tools),
      stopWhen: stepCountIs(steps),
      maxOutputTokens: 1500,
      abortSignal: ctx.signal,
      ...(loopOptions ? { providerOptions: loopOptions } : {}),
    });
  }

  return {
    resolve(ctx) {
      return loop(ctx, agentSystemPrompt(factsOf(ctx)), resolveUserPrompt(), RESOLVE_STEPS);
    },
    disambiguate(ctx) {
      return loop(
        ctx,
        disambiguationPrompt({ ...factsOf(ctx), lead: ctx.lead ?? "", runner: ctx.runner ?? "" }),
        "Call exactly one allowed tool, then finish.",
        DISAMBIGUATE_STEPS,
      );
    },
    enrich(ctx) {
      return loop(ctx, agentSystemPrompt(factsOf(ctx)), enrichUserPrompt(), ENRICH_STEPS);
    },
    async classifyRisk(hits, signal) {
      if (hits.length === 0) return [];
      const listed = hits.map((h) => `${h.sourceId}: ${h.title}`).join("\n");
      try {
        const object = await structuredObject(ClassificationSchema, {
          model: narrativeModel,
          system: "Classify only the listed hits. Never invent facts.",
          prompt: riskClassifyPrompt(listed),
          ...(signal ? { signal } : {}),
          ...(narrativeOptions ? { providerOptions: narrativeOptions } : {}),
        });
        const unused = [...hits];
        return object.hits.map((row) => {
          const idx = unused.findIndex((hit) => hit.sourceId === row.sourceId);
          const hit = idx >= 0 ? unused.splice(idx, 1)[0] : undefined;
          return { ...row, ...(hit?.title ? { title: hit.title } : {}) };
        });
      } catch {
        return [];
      }
    },
    async narrate(ctx) {
      const object = await structuredObject(NarrativeSchema, {
        model: narrativeModel,
        system: narrativePrompt(factsOf(ctx)),
        prompt: ctx.evidenceNotes,
        signal: ctx.signal,
        ...(narrativeOptions ? { providerOptions: narrativeOptions } : {}),
      });
      const candidateSummaries: Record<string, string> = {};
      for (const row of object.candidateSummaries) candidateSummaries[row.id] = row.summary;
      const reputationalSummaries: Record<string, string> = {};
      for (const row of object.reputationalSummaries) reputationalSummaries[row.sourceId] = row.summary;
      return { candidateSummaries, reputationalSummaries, rationale: object.rationale };
    },
  };
}

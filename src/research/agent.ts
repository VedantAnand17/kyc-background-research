// Agent loop: Vercel AI SDK tool calling with a 12-step limit. PRD.md sections 6.2 to 6.5 and 11.
// The model decides which allowed tool to call next. It never writes an amount, never assigns a
// confidence score, and never sees raw vendor payloads (ADR-0001).
import { generateObject, generateText, stepCountIs, tool, type ToolSet } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { llmBaseUrl, type Config } from "../config.js";
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
  classifyRisk(hits: readonly RiskHit[]): Promise<readonly RiskClassification[]> | readonly RiskClassification[];
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

function languageModel(config: Config) {
  if (config.LLM_PROVIDER === "openai") {
    return createOpenAI({ apiKey: config.LLM_API_KEY })(config.LLM_MODEL);
  }
  const baseURL = llmBaseUrl(config);
  if (!baseURL) throw new Error("LLM_BASE_URL is required for this provider");
  return createOpenAICompatible({
    name: config.LLM_PROVIDER,
    baseURL,
    apiKey: config.LLM_API_KEY,
  })(config.LLM_MODEL);
}

function reasoningOptions(model: string): { openaiCompatible: { reasoningEffort: string } } | undefined {
  if (!model.includes("gpt-oss")) return undefined;
  return { openaiCompatible: { reasoningEffort: "low" } };
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

export function createAgent(config: Config): ResearchAgent {
  const model = languageModel(config);
  const providerOptions = reasoningOptions(config.LLM_MODEL);

  async function loop(ctx: AgentContext, system: string, prompt: string): Promise<void> {
    if (ctx.signal.aborted) return;
    await generateText({
      model,
      system,
      prompt,
      tools: sdkTools(ctx.tools),
      stopWhen: stepCountIs(12),
      maxOutputTokens: 1500,
      abortSignal: ctx.signal,
      ...(providerOptions ? { providerOptions } : {}),
    });
  }

  return {
    resolve(ctx) {
      return loop(ctx, agentSystemPrompt(factsOf(ctx)), resolveUserPrompt());
    },
    disambiguate(ctx) {
      return loop(
        ctx,
        disambiguationPrompt({ ...factsOf(ctx), lead: ctx.lead ?? "", runner: ctx.runner ?? "" }),
        "Call exactly one allowed tool, then finish.",
      );
    },
    enrich(ctx) {
      return loop(ctx, agentSystemPrompt(factsOf(ctx)), enrichUserPrompt());
    },
    async classifyRisk(hits) {
      if (hits.length === 0) return [];
      const listed = hits.map((h) => `${h.sourceId}: ${h.title}`).join("\n");
      const result = await generateObject({
        model,
        schema: ClassificationSchema,
        system: "Classify only the listed hits. Never invent facts.",
        prompt: riskClassifyPrompt(listed),
        maxOutputTokens: 1200,
        ...(providerOptions ? { providerOptions } : {}),
      });
      return result.object.hits;
    },
    async narrate(ctx) {
      const result = await generateObject({
        model,
        schema: NarrativeSchema,
        system: narrativePrompt(factsOf(ctx)),
        prompt: ctx.evidenceNotes,
        maxOutputTokens: 1200,
        abortSignal: ctx.signal,
        ...(providerOptions ? { providerOptions } : {}),
      });
      const candidateSummaries: Record<string, string> = {};
      for (const row of result.object.candidateSummaries) candidateSummaries[row.id] = row.summary;
      const reputationalSummaries: Record<string, string> = {};
      for (const row of result.object.reputationalSummaries) reputationalSummaries[row.sourceId] = row.summary;
      return { candidateSummaries, reputationalSummaries, rationale: result.object.rationale };
    },
  };
}

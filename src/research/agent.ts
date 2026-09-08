// Agent loop: Vercel AI SDK tool calling with a 12-step limit. PRD.md sections 6.2 to 6.5 and 11.
// The model decides which allowed tool to call next. It never writes an amount, never assigns a
// confidence score, and never sees raw vendor payloads (ADR-0001).
import {
  generateText,
  hasToolCall,
  jsonSchema,
  stepCountIs,
  tool,
  type StopCondition,
  type ToolSet,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { llmBaseUrl, loopModelName, type Config } from "../config.js";
import { createLogger } from "../logger.js";
import type { ResearchTools } from "./tools.js";
import type { ToolName } from "./capabilities.js";
import { generateStructured, jsonSchemaOf, structuredReasoningEffort } from "./structured.js";
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

export { extractJsonObject } from "./structured.js";

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
  /** The resolved primary candidate, including the profileUrl the enrich tools take. */
  readonly primary?: string;
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

export interface ClassificationResult {
  readonly classifications: readonly RiskClassification[];
  readonly failed: boolean;
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
  /** `primary` describes the subject and the resolved primary candidate; without it the model cannot separate same-name people. */
  classifyRisk(
    hits: readonly RiskHit[],
    primary: string,
    signal?: AbortSignal,
  ): Promise<ClassificationResult> | ClassificationResult;
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

/** Same low-effort rule as structured calls: glm-5.3 at default effort spends 15-20 s thinking per loop turn. */
export function loopProviderOptions(model: string): { openaiCompatible: { reasoningEffort: string } } | undefined {
  const effort = structuredReasoningEffort(model);
  return effort ? { openaiCompatible: { reasoningEffort: effort } } : undefined;
}

function reasoningEffortOf(model: string): string | undefined {
  return structuredReasoningEffort(model);
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

/**
 * Stop once a step's tool calls were all accepted by code: the model's job in every phase is to pick tools,
 * and code owns the results, so the trailing finish turn is pure latency (3-6 s per turn on glm-5.3).
 * A rejected call (invalid_args) leaves the loop running so the model can repair it.
 */
export const toolCallsAccepted: StopCondition<ToolSet> = ({ steps }) => {
  const last = steps.at(-1);
  if (!last || last.toolCalls.length === 0) return false;
  return last.toolResults.every((row) => (row.output as { outcome?: string } | undefined)?.outcome !== "invalid_args");
};

const RESOLVE_STEPS = 4;
const DISAMBIGUATE_STEPS = 2;
const ENRICH_STEPS = 3;

export function createAgent(config: Config): ResearchAgent {
  const loopModel = languageModel(config, loopModelName(config));
  const loopOptions = loopProviderOptions(loopModelName(config));
  const log = createLogger(config.LOG_LEVEL);

  function sdkTools(tools: ResearchTools): ToolSet {
    const out: ToolSet = {};
    for (const [name, row] of Object.entries(tools)) {
      if (!row) continue;
      out[name] = tool({
        description: row.description,
        // The model sees the real argument schema; a loose record made it guess names and cost a repair turn per
        // phase (2026-09-08 trace: every resolve was two find_people calls). Validation stays in code below so a
        // bad call still returns invalid_args for self-repair instead of throwing out of the loop.
        inputSchema: jsonSchema<Record<string, unknown>>(jsonSchemaOf(row.inputSchema) as Parameters<typeof jsonSchema>[0], {
          validate: (value) => ({ success: true, value: (value ?? {}) as Record<string, unknown> }),
        }),
        execute: async (args) => {
          const parsed = row.inputSchema.safeParse(args);
          if (!parsed.success) {
            const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
            log.warn({ tool: name, issues }, "tool arguments invalid");
            return { outcome: "invalid_args", reason: issues.join("; "), issues };
          }
          return row.execute(parsed.data as Record<string, unknown>);
        },
      }) as ToolSet[string];
    }
    return out;
  }

  async function structured<T>(
    schema: z.ZodType<T>,
    input: { readonly system: string; readonly prompt: string; readonly name: string; readonly signal?: AbortSignal },
  ): Promise<T> {
    const effort = reasoningEffortOf(config.LLM_MODEL);
    return generateStructured(schema, {
      config,
      model: config.LLM_MODEL,
      system: input.system,
      prompt: input.prompt,
      name: input.name,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
    });
  }

  async function loop(ctx: AgentContext, system: string, prompt: string, steps: number): Promise<void> {
    if (ctx.signal.aborted) return;
    await generateText({
      model: loopModel,
      system,
      prompt,
      tools: sdkTools(ctx.tools),
      stopWhen: [stepCountIs(steps), hasToolCall("finish"), toolCallsAccepted],
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
      return loop(ctx, agentSystemPrompt(factsOf(ctx)), enrichUserPrompt(ctx.primary), ENRICH_STEPS);
    },
    async classifyRisk(hits, primary, signal) {
      if (hits.length === 0) return { classifications: [], failed: false };
      const listed = hits.map((h) => `${h.sourceId}: ${h.title}`).join("\n");
      try {
        const object = await structured(ClassificationSchema, {
          system: "Classify only the listed hits. Never invent facts.",
          prompt: riskClassifyPrompt(primary, listed),
          name: "classification",
          ...(signal ? { signal } : {}),
        });
        const unused = [...hits];
        return {
          failed: false,
          classifications: object.hits.map((row) => {
            const idx = unused.findIndex((hit) => hit.sourceId === row.sourceId);
            const hit = idx >= 0 ? unused.splice(idx, 1)[0] : undefined;
            return { ...row, ...(hit?.title ? { title: hit.title } : {}) };
          }),
        };
      } catch (err) {
        log.warn({ err, hitCount: hits.length }, "risk classification failed");
        return { classifications: [], failed: true };
      }
    },
    async narrate(ctx) {
      const object = await structured(NarrativeSchema, {
        system: narrativePrompt(factsOf(ctx)),
        prompt: ctx.evidenceNotes,
        name: "narrative",
        signal: ctx.signal,
      });
      const candidateSummaries: Record<string, string> = {};
      for (const row of object.candidateSummaries) candidateSummaries[row.id] = row.summary;
      const reputationalSummaries: Record<string, string> = {};
      for (const row of object.reputationalSummaries) reputationalSummaries[row.sourceId] = row.summary;
      return { candidateSummaries, reputationalSummaries, rationale: object.rationale };
    },
  };
}

// Agent loop: Vercel AI SDK tool calling with a 12-step limit. PRD.md sections 6.2 to 6.5 and 11.
// The model decides which allowed tool to call next. It never writes an amount, never assigns a
// confidence score, and never sees raw vendor payloads (ADR-0001).
//
// TODO(M5): implement runResolvePhase, runDisambiguationCall, runEnrichPhase, runRiskPhase using
// `generateText` with `tools` from tools.ts, `stopWhen: stepCountIs(12)`, the plan's AbortSignal,
// and `maxOutputTokens: 1500` on every call (ADR-0006: reasoning models return nothing otherwise).
// Provider selection by config.LLM_PROVIDER (see llmBaseUrl in config.ts):
//   cloudflare | openai-compatible -> createOpenAICompatible({ name, baseURL, apiKey }) from @ai-sdk/openai-compatible
//   openai                         -> createOpenAI({ apiKey }) from @ai-sdk/openai
// Default model @cf/zai-org/glm-5.3; fallback @cf/openai/gpt-oss-120b needs reasoning_effort low (ADR-0006).

export function createAgent(): never {
  throw new Error("TODO(M5): implement createAgent per PRD.md section 11");
}

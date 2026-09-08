// Agent loop: Vercel AI SDK tool calling with a 12-step limit. PRD.md sections 6.2 to 6.5 and 11.
// The model decides which allowed tool to call next. It never writes an amount, never assigns a
// confidence score, and never sees raw vendor payloads (ADR-0001).
//
// TODO(M5): implement runResolvePhase, runDisambiguationCall, runEnrichPhase, runRiskPhase using
// `generateText` with `tools` from tools.ts, `stopWhen: stepCountIs(12)`, and the plan's AbortSignal.
// Provider selection by config.LLM_PROVIDER: @ai-sdk/openai, @ai-sdk/anthropic, or createOpenAI({ baseURL }).

export function createAgent(): never {
  throw new Error("TODO(M5): implement createAgent per PRD.md section 11");
}

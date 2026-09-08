// System prompts as plain template strings. PRD.md section 11.
// Every prompt MUST state: the subject, the tier, remaining budget in dollars, the allowed tools,
// and that the model never invents facts absent from tool results.
//
// TODO(M5): write agentSystemPrompt(...), disambiguationPrompt(...), narrativePrompt(...).

export function agentSystemPrompt(): string {
  throw new Error("TODO(M5): implement agentSystemPrompt per PRD.md section 11");
}

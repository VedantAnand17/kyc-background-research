// System prompts as plain template strings. PRD.md section 11.
// Every prompt MUST state: the subject, the tier, remaining budget in dollars, the allowed tools,
// and that the model never invents facts absent from tool results.

export interface PromptFacts {
  readonly subject: string;
  readonly tier: string;
  readonly remainingBudget: string;
  readonly allowedTools: readonly string[];
}

function preamble(facts: PromptFacts): string {
  return [
    `Subject: ${facts.subject}.`,
    `Tier: ${facts.tier}.`,
    `Remaining budget: ${facts.remainingBudget} USD.`,
    `Allowed tools: ${facts.allowedTools.join(", ")}.`,
    "Never invent facts that are not present in tool results.",
    "Never write an amount, never assign an identity score, and never name a vendor.",
  ].join("\n");
}

export function agentSystemPrompt(facts: PromptFacts): string {
  return [
    preamble(facts),
    "You choose the next allowed tool to buy.",
    "Code will decide whether it is affordable, which vendor to use, and who the subject is.",
    "Call finish when the file is complete, every allowed tool has been used, or a tool returns budget_exhausted.",
  ].join("\n");
}

export function disambiguationPrompt(facts: PromptFacts & { readonly lead: string; readonly runner: string }): string {
  return [
    preamble(facts),
    "The matcher could not select a primary candidate.",
    `Closest lead: ${facts.lead}.`,
    `Closest runner-up: ${facts.runner}.`,
    "Pick exactly one allowed tool that would separate them.",
    "Then stop.",
  ].join("\n");
}

export function narrativePrompt(facts: PromptFacts): string {
  return [
    preamble(facts),
    "Fill only these narrative fields from the supplied evidence notes:",
    "each candidate summary, each reputational-hit summary, and the overall risk rationale.",
    "If a fact is missing, say so plainly. Never invent.",
  ].join("\n");
}

export function resolveUserPrompt(): string {
  return "Call find_people with the subject's full name and any location hint. Then finish.";
}

export function enrichUserPrompt(): string {
  return "Enrich the primary candidate with the allowed tools. Prefer several calls in one turn. Call finish when done.";
}

export function riskClassifyPrompt(hits: string): string {
  return [
    "Classify each news or web hit.",
    "Say whether it is about the primary candidate and assign severity low, medium, or high.",
    "Never invent hits that are not listed.",
    hits,
  ].join("\n");
}

export function describeSubject(input: {
  readonly firstName: string;
  readonly lastName: string;
  readonly dateOfBirth?: string;
  readonly address?: { readonly city?: string; readonly country?: string };
}): string {
  const parts = [`${input.firstName} ${input.lastName}`];
  if (input.dateOfBirth) parts.push(`born ${input.dateOfBirth}`);
  const place = [input.address?.city, input.address?.country].filter(Boolean).join(" ");
  if (place) parts.push(place);
  return parts.join(", ");
}

export function adverseMediaQuery(fullName: string): string {
  return `"${fullName}" fraud OR scam OR arrested OR indicted OR lawsuit OR sanctions`;
}

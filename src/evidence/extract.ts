// One extractor per capability: raw vendor payload -> typed facts + a <=1500 char summary for the model.
// PRD.md sections 6.4 and 9. Raw payloads never reach the model; this is where that rule is enforced.
//
// TODO(M3): implement extractors keyed by ToolName. Each returns { facts, candidateEvidence?, summary }.
// Fixtures in test/fixtures/<vendor>.json drive the tests.

export const SUMMARY_MAX_CHARS = 1_500;

export function extractFor(_tool: string, _raw: unknown): never {
  throw new Error("TODO(M3): implement extractFor per PRD.md section 9");
}

// Report assembler. PRD.md sections 5.4 and 6.6.
// Code fills identity, profile, risk statuses, costs (from the ledger), warnings, timing.
// The LLM fills exactly three narrative fields via structured output: candidate summaries,
// reputational hit summaries, risk.overall.rationale. On LLM failure they read "narrative unavailable".
// Overall risk level is a rule (section 5.4), never a model output.
// The finished object is validated against ReportSchema and its invariants before it is returned.
//
// TODO(M6): implement assembleReport().

export function assembleReport(): never {
  throw new Error("TODO(M6): implement assembleReport per PRD.md sections 5.4 and 6.6");
}

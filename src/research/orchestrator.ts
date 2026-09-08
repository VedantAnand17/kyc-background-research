// Runs the five phases for one request and owns the deadline. PRD.md section 6.
//
// TODO(M5):
//   0. plan()                                   -> Plan
//   1. resolve   (agent, find_people)           -> candidates
//   2. disambiguate (matcher; one reserve-funded discriminator call if ambiguous)
//   3. enrich    (agent, parallel, primary candidate only)
//   4. risk      (adverse-media queries from a fixed template list + screen_watchlist)
//   5. report    (assembler; narrative pass; schema validation)
// Deadline: AbortSignal at deadlineAt - 8000 ms synthesis allowance; await in-flight calls <= 5 s more;
// after the response, reconcile any held reservation through GET /v1/transactions.
import type { ResearchRequest } from "../api/schemas.js";

export interface OrchestratorDeps {
  // filled in M5: config, db, log, perflo client, agent, matcher
}

export async function runResearch(_req: ResearchRequest, _deps: OrchestratorDeps): Promise<unknown> {
  throw new Error("TODO(M5): implement runResearch per PRD.md section 6");
}

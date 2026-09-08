// Phase 0: budget -> tier, allowed tools, reserve, deadline. Pure code. PRD.md section 6.1.
//
// TODO(M5): implement.
//   basic:    cap <  0.500000 USD
//   standard: 0.500000 <= cap <= 2.000000 USD
//   deep:     cap >  2.000000 USD
//   reserveMicro = ceilFraction(capMicro, 1n, 10n)
//   deadlineAt   = now + (request.options?.deadlineMs ?? config.RESEARCH_DEADLINE_MS)
import type { Micro } from "../budget/money.js";
import type { Tier, ToolName } from "./capabilities.js";

export interface Plan {
  readonly tier: Tier;
  readonly allowedTools: readonly ToolName[];
  readonly capMicro: Micro;
  readonly reserveMicro: Micro;
  readonly deadlineAt: number;
}

export function plan(_capMicro: Micro, _deadlineMs: number, _now: number = Date.now()): Plan {
  throw new Error("TODO(M5): implement plan() per PRD.md section 6.1");
}

// Phase 0: budget -> tier, allowed tools, reserve, deadline. Pure code. PRD.md section 6.1.
import { ceilFraction, type Micro } from "../budget/money.js";
import { toolsForTier, type Tier, type ToolName } from "./capabilities.js";

export interface Plan {
  readonly tier: Tier;
  readonly allowedTools: readonly ToolName[];
  readonly capMicro: Micro;
  readonly reserveMicro: Micro;
  readonly deadlineAt: number;
}

const BASIC_MAX = 499_999n;
const STANDARD_MAX = 2_000_000n;

export function tierForCap(capMicro: Micro): Tier {
  if (capMicro < 0n) throw new RangeError(`negative cap: ${capMicro}`);
  if (capMicro <= BASIC_MAX) return "basic";
  if (capMicro <= STANDARD_MAX) return "standard";
  return "deep";
}

/** Wall-clock default when the request and operator config omit deadlineMs. */
export function defaultDeadlineMs(capMicro: Micro): number {
  return tierForCap(capMicro) === "deep" ? 90_000 : 60_000;
}

export function plan(capMicro: Micro, deadlineMs: number, now: number = Date.now()): Plan {
  if (deadlineMs <= 0) throw new RangeError(`deadline must be positive: ${deadlineMs}`);
  const tier = tierForCap(capMicro);
  return {
    tier,
    allowedTools: toolsForTier(tier).map((c) => c.tool),
    capMicro,
    reserveMicro: ceilFraction(capMicro, 1n, 10n),
    deadlineAt: now + deadlineMs,
  };
}

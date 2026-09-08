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

/**
 * Wall-clock default when the request and operator config omit deadlineMs.
 * Measured on the funded catalog (M7, 2026-09-08): Perflo settles each call on-chain in about 9-11 s
 * server-side, and the Apify profile, enrichment, and skip-trace actors take about 30 s. A basic run is
 * resolve, then a parallel enrich turn, then the 15 s report window, with a model turn between each;
 * standard and deep add a 30 s disambiguation step. 120 s is the schema maximum for deadlineMs.
 */
const DEADLINE_MS: Readonly<Record<Tier, number>> = { basic: 90_000, standard: 120_000, deep: 120_000 };

export function defaultDeadlineMs(capMicro: Micro): number {
  return DEADLINE_MS[tierForCap(capMicro)];
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

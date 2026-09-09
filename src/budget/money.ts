// Money is integer micro-dollars in bigint. 1 USD = 1_000_000n.
// This is the ONLY module that parses or formats amounts. See PRD.md section 7.1.
// A `number` holding money anywhere in this codebase is a bug.

export type Micro = bigint;

export const MICRO_PER_USD = 1_000_000n;

export interface Money {
  readonly amount: string;
  readonly currency: "USD";
}

const AMOUNT_RE = /^(\d+)(?:\.(\d{1,6}))?$/;

/** Parse a Perflo-style decimal string ("0.0252") into micro-dollars. Throws on anything else. */
export function parseMoney(amount: string): Micro {
  const m = AMOUNT_RE.exec(amount);
  if (!m) throw new RangeError(`invalid money amount: ${JSON.stringify(amount)}`);
  const whole = BigInt(m[1]!);
  const frac = (m[2] ?? "").padEnd(6, "0");
  return whole * MICRO_PER_USD + BigInt(frac);
}

/** Format micro-dollars as a decimal string with exactly six fractional digits. */
export function formatMoney(micro: Micro): string {
  if (micro < 0n) throw new RangeError(`negative money amount: ${micro}`);
  const whole = micro / MICRO_PER_USD;
  const frac = (micro % MICRO_PER_USD).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

export function toMoney(micro: Micro): Money {
  return { amount: formatMoney(micro), currency: "USD" };
}

/** Ceil(micro * numerator / denominator). */
export function ceilFraction(micro: Micro, numerator: bigint, denominator: bigint): Micro {
  const product = micro * numerator;
  return (product + denominator - 1n) / denominator;
}

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface LiveLlmCredentials {
  readonly apiKey: string;
  readonly accountId: string;
}

function valueFromDotenv(raw: string, key: string): string | undefined {
  const match = raw.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!match) return undefined;
  const value = match[1]?.trim().replace(/^['"]|['"]$/g, "");
  return value || undefined;
}

/** Live Workers AI credentials from the environment or a local .env. Absent in CI. */
export function liveLlmCredentials(): LiveLlmCredentials | null {
  const envFile = existsSync(resolve(".env")) ? readFileSync(resolve(".env"), "utf8") : "";
  const apiKey = process.env.LLM_API_KEY || valueFromDotenv(envFile, "LLM_API_KEY");
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || valueFromDotenv(envFile, "CLOUDFLARE_ACCOUNT_ID");
  if (!apiKey || !accountId) return null;
  return { apiKey, accountId };
}

export function livePerfloKey(): string | null {
  const envFile = existsSync(resolve(".env")) ? readFileSync(resolve(".env"), "utf8") : "";
  const key = process.env.PERFLO_AGENT_KEY || valueFromDotenv(envFile, "PERFLO_AGENT_KEY");
  return key || null;
}

export const LIVE_PHASE_TARGETS_MS = {
  basic: 30_000,
  standard: 45_000,
  deep: 45_000,
  resolve: 25_000,
  enrich: 25_000,
  screen: 20_000,
  report: 15_000,
} as const;

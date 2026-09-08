// Structured JSON logs. PRD.md section 14. Never log PERFLO_AGENT_KEY, LLM_API_KEY, or raw vendor payloads at info.
import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: { paths: ["*.authorization", "*.apiKey", "*.PERFLO_AGENT_KEY", "*.LLM_API_KEY"], censor: "[redacted]" },
  });
}

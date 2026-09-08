// Read once at startup, validated with Zod. PRD.md section 13 is the source of truth.
import { z } from "zod";

const bool = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

const intInRange = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const schema = z
  .object({
    PERFLO_AGENT_KEY: z.string().min(1).optional(),
    PERFLO_BASE_URL: z.url().default("https://pay-per-use-api.perflo.ai"),
    LLM_PROVIDER: z.enum(["openai", "anthropic", "openai-compatible"]),
    LLM_MODEL: z.string().min(1),
    LLM_API_KEY: z.string().min(1),
    LLM_BASE_URL: z.url().optional(),
    RESEARCH_DEADLINE_MS: intInRange(5_000, 120_000, 45_000),
    TOOL_CONCURRENCY: intInRange(1, 16, 4),
    VENDOR_TIMEOUT_MS: intInRange(1_000, 60_000, 15_000),
    DATABASE_PATH: z.string().default("./data/research.db"),
    FIXTURE_MODE: bool,
    PORT: intInRange(1, 65_535, 3_000),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  })
  .refine((c) => c.FIXTURE_MODE || Boolean(c.PERFLO_AGENT_KEY), {
    message: "PERFLO_AGENT_KEY is required unless FIXTURE_MODE=true",
    path: ["PERFLO_AGENT_KEY"],
  })
  .refine((c) => c.LLM_PROVIDER !== "openai-compatible" || Boolean(c.LLM_BASE_URL), {
    message: "LLM_BASE_URL is required when LLM_PROVIDER=openai-compatible",
    path: ["LLM_BASE_URL"],
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`invalid configuration:\n${lines.join("\n")}`);
  }
  return result.data;
}

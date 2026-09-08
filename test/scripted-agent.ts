import type { ClassificationResult, ResearchAgent } from "../src/research/agent.js";
import type { ResearchTools } from "../src/research/tools.js";

async function call(
  tools: ResearchTools,
  name: keyof ResearchTools,
  args: Record<string, unknown> = {},
): Promise<void> {
  const tool = tools[name];
  if (!tool) return;
  await tool.execute(args);
}

/** Deterministic agent for tests: follows the PRD's prescribed first actions, no LLM. */
export function createScriptedAgent(
  over: {
    disambiguate?: "skip" | "professional";
    classify?: (hits: readonly { sourceId: string; title: string }[]) => ClassificationResult;
  } = {},
): ResearchAgent {
  return {
    async resolve(ctx) {
      const locationHint = [ctx.subject.address?.city, ctx.subject.address?.country].filter(Boolean).join(", ");
      await call(ctx.tools, "find_people", {
        fullName: `${ctx.subject.firstName} ${ctx.subject.lastName}`,
        ...(locationHint ? { locationHint } : {}),
      });
    },
    async disambiguate(ctx) {
      if (over.disambiguate === "skip") return;
      const fullName = `${ctx.subject.firstName} ${ctx.subject.lastName}`;
      if (ctx.tools.skip_trace) {
        await call(ctx.tools, "skip_trace", {
          fullName,
          city: ctx.subject.address?.city,
          region: ctx.subject.address?.region,
        });
        return;
      }
      await call(ctx.tools, "get_professional_profile", { fullName });
    },
    async enrich(ctx) {
      const fullName = `${ctx.subject.firstName} ${ctx.subject.lastName}`;
      const calls: Array<Promise<void>> = [];
      if (ctx.tools.get_professional_profile) calls.push(call(ctx.tools, "get_professional_profile", { fullName }));
      if (ctx.tools.enrich_person) {
        calls.push(call(ctx.tools, "enrich_person", { fullName, location: ctx.subject.address?.city }));
      }
      if (ctx.tools.get_social_profile) {
        calls.push(call(ctx.tools, "get_social_profile", { network: "x", handleOrName: ctx.subject.firstName }));
      }
      if (ctx.tools.search_filings) calls.push(call(ctx.tools, "search_filings", { fullName }));
      await Promise.all(calls);
    },
    classifyRisk(hits) {
      if (over.classify) return over.classify(hits);
      return {
        failed: false,
        classifications: hits.map((hit) => ({
          sourceId: hit.sourceId,
          title: hit.title,
          aboutPrimary: true,
          severity: "low" as const,
          summary: hit.title,
        })),
      };
    },
    async narrate() {
      return {
        candidateSummaries: {},
        reputationalSummaries: {},
        rationale: "No adverse media or watchlist hits were attached to the primary candidate.",
      };
    },
  };
}

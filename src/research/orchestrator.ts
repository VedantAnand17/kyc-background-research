// Runs the five phases for one request and owns the deadline. PRD.md section 6.
import { randomUUID } from "node:crypto";
import { parseMoney, formatMoney, type Micro } from "../budget/money.js";
import { createSpendGuard, type SpendGuard } from "../budget/ledger.js";
import { createEvidenceStore } from "../evidence/store.js";
import { decideIdentity, type SubjectInput } from "../identity/matcher.js";
import type { ResearchRequest, ResearchReport } from "../api/schemas.js";
import type { Db } from "../db/sqlite.js";
import type { Logger } from "../logger.js";
import type { PerfloClient } from "../perflo/client.js";
import type { ResearchAgent, AgentContext, ClassificationResult, RiskClassification, RiskHit } from "./agent.js";
import { assembleReport, type CostCall, type Warning } from "../evidence/report.js";
import { PerfloError } from "../perflo/errors.js";
import { candidatesFromSources } from "./candidates.js";
import { defaultDeadlineMs, plan } from "./planner.js";
import { adverseMediaQuery } from "./prompts.js";
import { createTools, type ResearchTools, type ToolOutcome } from "./tools.js";

export class ResearchUnavailableError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ResearchUnavailableError";
  }
}

/** Wall-clock reserved for the narrative pass. Constrained json_schema on glm-5.3 measured at 5.8 s. */
export const SYNTHESIS_MS = 12_000;
const DRAIN_MS = 5_000;

export interface OrchestratorDeps {
  readonly db: Db;
  readonly log: Logger;
  readonly client: PerfloClient;
  readonly agent: ResearchAgent;
  readonly now?: number;
  readonly deadlineMs?: number;
  readonly concurrency?: number;
}

interface LedgerRow {
  readonly id: string;
  readonly vendor: string;
  readonly capability: string;
  readonly charged_micro: string | null;
  readonly transaction_id: string | null;
  readonly state: string;
}

function subjectOf(req: ResearchRequest): SubjectInput {
  return {
    fullName: `${req.firstName} ${req.lastName}`,
    ...(req.dateOfBirth ? { dateOfBirth: req.dateOfBirth } : {}),
    ...(req.address?.city ? { city: req.address.city } : {}),
    ...(req.address?.country ? { country: req.address.country } : {}),
  };
}

function wrapTools(
  tools: ResearchTools,
  onExhausted: () => void,
  onFailed: (result: Extract<ToolOutcome, { outcome: "failed" }>) => void,
): ResearchTools {
  const out: ResearchTools = {};
  for (const [name, row] of Object.entries(tools)) {
    if (!row) continue;
    out[name as keyof ResearchTools] = {
      ...row,
      async execute(args: Record<string, unknown>): Promise<ToolOutcome> {
        const result = await row.execute(args);
        if (result.outcome === "budget_exhausted") onExhausted();
        if (result.outcome === "failed") onFailed(result);
        return result;
      },
    };
  }
  return out;
}

function agentCtx(
  req: ResearchRequest,
  planTier: string,
  allowed: readonly import("./capabilities.js").ToolName[],
  tools: ResearchTools,
  guard: SpendGuard,
  signal: AbortSignal,
  extra: Partial<AgentContext> = {},
): AgentContext {
  return {
    subject: {
      firstName: req.firstName,
      lastName: req.lastName,
      ...(req.dateOfBirth ? { dateOfBirth: req.dateOfBirth } : {}),
      ...(req.address
        ? {
            address: {
              ...(req.address.city ? { city: req.address.city } : {}),
              ...(req.address.region ? { region: req.address.region } : {}),
              ...(req.address.country ? { country: req.address.country } : {}),
            },
          }
        : {}),
    },
    tier: planTier,
    remainingBudget: formatMoney(guard.snapshot().headroomMicro),
    allowedTools: allowed,
    tools,
    signal,
    ...extra,
  };
}

async function reconcileHeld(db: Db, jobId: string, guard: SpendGuard, client: PerfloClient, log: Logger): Promise<void> {
  const held = db
    .prepare(`SELECT id, transaction_id, idempotency_key FROM ledger WHERE job_id = ? AND state = 'held'`)
    .all(jobId) as Array<{ id: string; transaction_id: string | null; idempotency_key: string }>;
  for (const row of held) {
    try {
      let tx = null;
      if (row.transaction_id) {
        tx = await client.getTransaction(row.transaction_id);
      } else {
        const listed = await client.listTransactions({ limit: 50 });
        tx = listed.find((item) => item.idempotencyKey === row.idempotency_key) ?? null;
      }
      if (tx && tx.ledgerState === "posted" && tx.amount.amount.startsWith("-")) {
        guard.resolveHold(row.id, {
          chargedMicro: parseMoney(tx.amount.amount.slice(1)),
          transactionId: tx.id,
        });
      } else {
        guard.resolveHold(row.id, null);
      }
    } catch (err) {
      log.error({ jobId, reservationId: row.id, err }, "unreconciled held reservation");
      guard.resolveHold(row.id, null);
    }
  }
}

export async function runResearch(req: ResearchRequest, deps: OrchestratorDeps): Promise<ResearchReport> {
  try {
    await deps.client.getBalance();
  } catch (err) {
    const code = err instanceof PerfloError ? err.code : "NETWORK_ERROR";
    const message = err instanceof Error ? err.message : "Perflo is unreachable.";
    throw new ResearchUnavailableError(code, message);
  }

  const started = deps.now ?? Date.now();
  const capMicro = parseMoney(req.maxBudget.amount);
  const deadlineMs = req.options?.deadlineMs ?? deps.deadlineMs ?? defaultDeadlineMs(capMicro);
  const planned = plan(capMicro, deadlineMs, started);
  const requestId = `req_${randomUUID()}`;
  const warnings: Warning[] = [];
  const phases: Record<string, number> = {};
  let deadlineHit = false;
  let currentPhase = "plan";
  let exhausted = false;

  deps.db
    .prepare(
      `INSERT INTO jobs (id, created_at, tier, cap_micro, spent_micro, status, request_json)
       VALUES (?, ?, ?, ?, '0', 'running', ?)`,
    )
    .run(requestId, new Date().toISOString(), planned.tier, capMicro.toString(), JSON.stringify(req));

  const guard = createSpendGuard({
    db: deps.db,
    jobId: requestId,
    capMicro,
    reserveMicro: planned.reserveMicro,
  });
  const store = createEvidenceStore(deps.db, requestId);
  const controller = new AbortController();
  const abortAt = planned.deadlineAt - SYNTHESIS_MS;

  const fireDeadline = (): void => {
    if (deadlineHit) return;
    deadlineHit = true;
    warnings.push({
      code: "deadline_hit",
      message: `Deadline cut the ${currentPhase} phase; the report uses evidence collected so far.`,
    });
    controller.abort();
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (Date.now() >= abortAt) fireDeadline();
  else timer = setTimeout(fireDeadline, abortAt - Date.now());

  const tools = wrapTools(
    createTools({
      jobId: requestId,
      client: deps.client,
      guard,
      store,
      allowedTools: planned.allowedTools,
      signal: controller.signal,
      concurrency: deps.concurrency ?? 4,
    }),
    () => {
      if (!exhausted) {
        exhausted = true;
        warnings.push({
          code: "budget_exhausted",
          message: "Remaining headroom is below the cheapest live quote among the allowed tools.",
        });
      }
    },
    (result) => {
      if (!warnings.some((w) => w.code === result.code && w.message === result.reason)) {
        warnings.push({ code: result.code, message: result.reason });
      }
    },
  );

  let phaseWork: Promise<unknown> = Promise.resolve();
  const phaseFailed: Record<string, boolean> = {};

  const noteLlmFailure = (phase: string, err: unknown): void => {
    phaseFailed[phase] = true;
    deps.log.warn({ err, phase, requestId }, "phase failed");
    warnings.push({
      code: "llm_unavailable",
      message: `Model call failed during ${phase}.`,
    });
  };

  const runPhase = async (name: string, fn: () => Promise<void>): Promise<void> => {
    if (controller.signal.aborted) return;
    currentPhase = name;
    const t0 = Date.now();
    const work = fn();
    phaseWork = work.catch(() => undefined);
    try {
      await work;
    } catch (err) {
      if (!controller.signal.aborted) noteLlmFailure(name, err);
    }
    phases[name] = Date.now() - t0;
  };

  const ctx = (extra?: Partial<AgentContext>) =>
    agentCtx(req, planned.tier, planned.allowedTools, tools, guard, controller.signal, extra);

  await runPhase("resolve", () => deps.agent.resolve(ctx()));

  if (phaseFailed.resolve && store.forJob().length === 0) {
    if (timer) clearTimeout(timer);
    throw new ResearchUnavailableError(
      "llm_unavailable",
      "Model call failed before the first lookup.",
    );
  }

  let evidence = candidatesFromSources(store.forJob());
  let identity = decideIdentity(subjectOf(req), evidence);
  let adverseOnly = identity.status === "ambiguous";
  const skipResearch = identity.status === "not_found";

  if (!skipResearch && identity.status === "ambiguous" && !controller.signal.aborted) {
    await runPhase("disambiguate", async () => {
      const [lead, runner] = identity.candidates;
      const before = guard.snapshot();
      guard.unlockReserve();
      await deps.agent.disambiguate(
        ctx({
          lead: lead ? `${lead.id} ${lead.confidence}` : "",
          runner: runner ? `${runner.id} ${runner.confidence}` : "",
        }),
      );
      const after = guard.snapshot();
      guard.relockAfterUnlock(after.spentMicro - before.spentMicro, before.headroomMicro);
      evidence = candidatesFromSources(store.forJob());
      identity = decideIdentity(subjectOf(req), evidence);
      adverseOnly = identity.status === "ambiguous";
    });
  }

  let classifications: RiskClassification[] = [];
  let watchlistScreened = false;
  let watchlistHits = false;

  const screenPhase = async (): Promise<void> => {
    const fullName = `${req.firstName} ${req.lastName}`;
    const query = adverseMediaQuery(fullName);
    if (tools.search_news) await tools.search_news.execute({ query });
    if (tools.search_web) await tools.search_web.execute({ query });
    if (tools.screen_watchlist) {
      const result = await tools.screen_watchlist.execute({
        fullName,
        dateOfBirth: req.dateOfBirth,
        country: req.address?.country,
      });
      if (result.outcome === "unavailable") {
        warnings.push({
          code: "pep_not_screened",
          message: "PEP screening not available: no payable watchlist vendor in the Perflo catalog at run time.",
        });
        warnings.push({
          code: "sanctions_not_screened",
          message:
            "Sanctions screening not available: no payable watchlist vendor in the Perflo catalog at run time.",
        });
      } else if (result.outcome === "ok" && result.sourceId) {
        watchlistScreened = true;
        const source = store.byId(result.sourceId);
        const facts = source?.extracted as { facts?: { hits?: unknown[] } } | undefined;
        watchlistHits = (facts?.facts?.hits?.length ?? 0) > 0;
      }
    }
    const hits: RiskHit[] = [];
    for (const source of store.forJob()) {
      if (source.status !== "succeeded") continue;
      if (source.capability !== "search_news" && source.capability !== "search_web") continue;
      const facts = source.extracted as {
        facts?: { articles?: Array<{ title?: string }>; results?: Array<{ title?: string }> };
      };
      const items = facts.facts?.articles ?? facts.facts?.results ?? [];
      for (const item of items) {
        if (item.title) hits.push({ sourceId: source.id, title: item.title });
      }
    }
    const classified: ClassificationResult = await Promise.resolve(
      deps.agent.classifyRisk(hits, controller.signal),
    );
    if (classified.failed) {
      classifications = [];
      warnings.push({
        code: "unclassified",
        message:
          "Risk classification failed; news and reputational hits were not attributed to the primary candidate.",
      });
    } else {
      classifications = [...classified.classifications];
    }
  };

  if (!skipResearch && !adverseOnly) {
    currentPhase = "enrich";
    await Promise.all([runPhase("enrich", () => deps.agent.enrich(ctx())), runPhase("screen", screenPhase)]);
    evidence = candidatesFromSources(store.forJob());
    identity = decideIdentity(subjectOf(req), evidence);
  } else if (!skipResearch) {
    await runPhase("screen", screenPhase);
  }

  if (deadlineHit) {
    await Promise.race([phaseWork, new Promise((resolve) => setTimeout(resolve, DRAIN_MS))]);
  }
  if (timer) clearTimeout(timer);

  if (identity.status === "not_found") {
    warnings.push({ code: "identity_not_found", message: "No candidates were returned for the subject." });
  }
  if (identity.status === "ambiguous") {
    warnings.push({
      code: "identity_ambiguous",
      message: "Two or more candidates remain too close to select a primary; profile sections are empty.",
    });
  }
  for (const message of identity.warnings) {
    warnings.push({ code: "identity_input", message });
  }

  currentPhase = "report";
  const tReport = Date.now();
  let narrative = {
    candidateSummaries: {} as Record<string, string>,
    reputationalSummaries: {} as Record<string, string>,
    rationale: "narrative unavailable",
  };
  const notes = [
    `identity ${identity.status} primary=${identity.primaryCandidateId ?? "none"}`,
    ...identity.candidates.map(
      (c) => `candidate ${c.id} ${c.label} ${c.confidence} matched=${c.matchedOn.join(",")} conflicts=${c.conflicts.join(",")}`,
    ),
    ...store.forJob().map((s) => {
      const extracted = s.extracted as { summary?: unknown } | undefined;
      const summary = typeof extracted?.summary === "string" ? extracted.summary : "";
      return `${s.id} ${s.capability} ${s.status}${summary ? `: ${summary}` : ""}`;
    }),
  ].join("\n");
  const reportBudgetEnds = Date.now() + SYNTHESIS_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = reportBudgetEnds - Date.now();
    if (remaining < 3_000) break;
    try {
      narrative = await deps.agent.narrate({
        ...ctx(),
        signal: AbortSignal.timeout(remaining),
        evidenceNotes: notes,
      });
      break;
    } catch (err) {
      if (attempt === 1 || reportBudgetEnds - Date.now() < 3_000) {
        noteLlmFailure("report", err);
        warnings.push({
          code: "narrative_unavailable",
          message: "Narrative pass failed after two retries; summaries use the fallback string.",
        });
        break;
      }
    }
  }
  phases.report = Date.now() - tReport;

  await reconcileHeld(deps.db, requestId, guard, deps.client, deps.log);

  const ledgerRows = deps.db
    .prepare(`SELECT id, vendor, capability, charged_micro, transaction_id, state FROM ledger WHERE job_id = ?`)
    .all(requestId) as LedgerRow[];
  const byLedger = new Map(ledgerRows.map((row) => [row.id, row]));
  const calls: CostCall[] = [];
  for (const source of store.forJob()) {
    if (!source.ledgerId) continue;
    const row = byLedger.get(source.ledgerId);
    if (!row || row.state !== "settled") continue;
    calls.push({
      sourceId: source.id,
      vendor: source.vendor,
      capability: source.capability,
      status: source.status,
      chargedMicro: BigInt(row.charged_micro ?? "0") as Micro,
      transactionId: row.transaction_id,
    });
  }

  const report = assembleReport({
    requestId,
    request: req,
    tier: planned.tier,
    identity,
    sources: store.forJob(),
    calls,
    capMicro,
    warnings,
    timing: {
      totalMs: Math.max(0, Date.now() - started),
      deadlineHit,
      phases,
    },
    narrative,
    classifications,
    watchlistScreened,
    watchlistHits,
    screenRan: phases.screen !== undefined,
    ledgerSpentMicro: guard.snapshot().spentMicro,
  });

  const spent = guard.snapshot().spentMicro;
  deps.db
    .prepare(`UPDATE jobs SET finished_at = ?, spent_micro = ?, status = 'succeeded', report_json = ? WHERE id = ?`)
    .run(new Date().toISOString(), spent.toString(), JSON.stringify(report), requestId);

  return report;
}

// M7 live verification: real glm-5.3 and real, funded Perflo. Spends money.
// Runs only via `pnpm test:paid` (vitest.paid.config.ts) and only when both PERFLO_AGENT_KEY and
// Workers AI credentials are present. Records fixtures for FIXTURE_MODE into test/fixtures/ as it goes.
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseMoney } from "../src/budget/money.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/sqlite.js";
import { createLogger } from "../src/logger.js";
import { createPerfloClient, type PerfloClient } from "../src/perflo/client.js";
import type { ResearchRequest, ResearchReport } from "../src/api/schemas.js";
import { createAgent } from "../src/research/agent.js";
import { runResearch } from "../src/research/orchestrator.js";
import { liveLlmCredentials, livePerfloKey } from "./live-env.js";

const perfloKey = livePerfloKey();
const llm = liveLlmCredentials();
const funded = Boolean(perfloKey && llm);

const FIXTURE_ROOT = resolve("test/fixtures");

/** Keys whose values are contact details; fixtures keep shape and charged amounts but not these. */
const CONTACT_KEY =
  /^(phone(-\d+)?|phones|phone_numbers|personal_numbers|mobile|mobile_phone|email(-\d+)?|emails|personal_emails|work_email|street|street[ _]address|address_line\d?|line1|line2|ssn|postal[ _]code|zip)$/i;

export function scrubContacts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubContacts);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (CONTACT_KEY.test(key)) out[key] = Array.isArray(item) ? [] : typeof item === "string" ? "[redacted]" : item;
    else out[key] = scrubContacts(item);
  }
  return out;
}

function writeFixture(rel: string, data: unknown): void {
  const path = join(FIXTURE_ROOT, rel);
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

/** Pass every call through to Perflo and record the first successful response per fixture path. */
function recordingClient(real: PerfloClient): PerfloClient {
  return {
    async getVendor(slug) {
      const contract = await real.getVendor(slug);
      writeFixture(`vendors/${slug}.contract.json`, contract);
      return contract;
    },
    async search(query, opts) {
      const rows = await real.search(query, opts);
      const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "empty";
      writeFixture(`search/${slug}.json`, rows);
      return rows;
    },
    async pay(slug, args) {
      const paid = await real.pay(slug, args);
      if (paid.status === "succeeded") writeFixture(`pay/${slug}/succeeded.json`, scrubContacts(paid));
      return paid;
    },
    getTransaction: (id) => real.getTransaction(id),
    listTransactions: (opts) => real.listTransactions(opts),
    getTask: (runId) => real.getTask(runId),
    async getKey() {
      const key = await real.getKey();
      writeFixture("key.json", key);
      return key;
    },
  };
}

interface Subject {
  readonly label: string;
  readonly request: ResearchRequest;
  readonly tier: "basic" | "standard" | "deep";
}

const SUBJECTS: readonly Subject[] = [
  {
    label: "basic",
    tier: "basic",
    request: {
      firstName: "Satya",
      lastName: "Nadella",
      dateOfBirth: "1967-08-19",
      address: { city: "Redmond", region: "WA", country: "US" },
      maxBudget: { amount: "0.40", currency: "USD" },
    },
  },
  {
    label: "standard",
    tier: "standard",
    request: {
      firstName: "Sundar",
      lastName: "Pichai",
      address: { city: "Mountain View", region: "CA", country: "US" },
      maxBudget: { amount: "1.50", currency: "USD" },
    },
  },
  {
    label: "deep",
    tier: "deep",
    // A public figure who is actually on LinkedIn: the live candidate finder is LinkedIn-based, so a subject
    // without a profile (Elon Musk, tried first) is correctly not_found rather than a usable deep-tier run.
    request: {
      firstName: "Marc",
      lastName: "Benioff",
      dateOfBirth: "1964-09-25",
      address: { city: "San Francisco", region: "CA", country: "US" },
      maxBudget: { amount: "3.00", currency: "USD" },
    },
  },
];

const dbs: Array<{ close: () => void }> = [];
afterAll(() => {
  for (const db of dbs) db.close();
});

function liveDeps() {
  if (!perfloKey || !llm) throw new Error("unreachable: suite is skipped without credentials");
  const config = loadConfig({
    FIXTURE_MODE: "false",
    PERFLO_AGENT_KEY: perfloKey,
    LLM_PROVIDER: "cloudflare",
    CLOUDFLARE_ACCOUNT_ID: llm.accountId,
    LLM_API_KEY: llm.apiKey,
    LLM_MODEL: "@cf/zai-org/glm-5.3",
    LOG_LEVEL: "error",
  });
  const real = createPerfloClient({
    baseUrl: config.PERFLO_BASE_URL,
    agentKey: perfloKey,
    timeoutMs: config.VENDOR_TIMEOUT_MS,
  });
  const db = openDatabase(":memory:");
  dbs.push(db);
  // Warnings (vendor timeouts, failed model calls with their error) go to stderr: this suite is run by a person
  // reading the output, and a silenced "narrative unavailable" is undiagnosable after the money is spent.
  return { db, log: createLogger("warn"), client: recordingClient(real), agent: createAgent(config), real };
}

/**
 * Sum of Perflo's own view of this run's transactions. The pay response's transactionId is an alias that
 * GET /v1/transactions/{id} resolves to the canonical row (observed 2026-09-08: settlement on the `-tempo`
 * variant gives the row a different id), so each recorded id is resolved rather than matched against the list.
 */
async function perfloTotalFor(report: ResearchReport, real: PerfloClient): Promise<bigint> {
  const ids = new Set(report.costs.calls.map((row) => row.transactionId).filter((id): id is string => Boolean(id)));
  const canonical = new Set<string>();
  let total = 0n;
  for (const id of ids) {
    // A row settled while its vendor task was still running keeps the run id; the task resolves to the posted transaction.
    const txId = id.startsWith("run_") ? (await real.getTask(id)).transactionId : id;
    expect(txId, `${id} resolved to a transaction`).toBeTruthy();
    const tx = await real.getTransaction(txId!);
    if (canonical.has(tx.id)) continue;
    canonical.add(tx.id);
    expect(tx.ledgerState, `${id} ledger state`).not.toBe("voided");
    total += parseMoney(tx.amount.amount.replace(/^-/, ""));
  }
  return total;
}

describe.skipIf(!funded)("M7 funded Perflo verification", () => {
  it.each(SUBJECTS)(
    "$label: real subject stays under cap and the ledger equals GET /v1/transactions",
    async ({ request, tier }) => {
      const { real, ...deps } = liveDeps();
      const report = await runResearch(request, deps);
      const cap = parseMoney(request.maxBudget.amount);
      const total = parseMoney(report.costs.total.amount);
      const sum = report.costs.calls.reduce((acc, row) => acc + parseMoney(row.charged.amount), 0n);

      expect(report.tier).toBe(tier);
      expect(total).toBeLessThanOrEqual(cap);
      expect(total).toBe(sum);
      expect(parseMoney(report.costs.remaining.amount)).toBe(cap - total);
      expect(total, "a funded run must buy at least one lookup").toBeGreaterThan(0n);
      expect(await perfloTotalFor(report, real)).toBe(total);
      expect(report.identity.status).not.toBe("not_found");
      expect(report.risk.overall.rationale).not.toBe("narrative unavailable");
    },
    180_000,
  );

  it(
    "refuses a $0.05 cap without exceeding it",
    async () => {
      const { real, ...deps } = liveDeps();
      const request: ResearchRequest = { ...SUBJECTS[0]!.request, maxBudget: { amount: "0.05", currency: "USD" } };
      const report = await runResearch(request, deps);
      const total = parseMoney(report.costs.total.amount);
      expect(total).toBeLessThanOrEqual(parseMoney("0.05"));
      for (const call of report.costs.calls) expect(parseMoney(call.charged.amount)).toBeLessThanOrEqual(parseMoney("0.05"));
      expect(report.warnings.map((w) => w.code)).toContain("budget_exhausted");
      expect(await perfloTotalFor(report, real)).toBe(total);
    },
    180_000,
  );

  it(
    "returns not_found for a nonexistent person",
    async () => {
      const { real, ...deps } = liveDeps();
      const request: ResearchRequest = {
        firstName: "Zebulon",
        lastName: "Quarnstromfeldt",
        address: { city: "Boise", region: "ID", country: "US" },
        maxBudget: { amount: "0.40", currency: "USD" },
      };
      const report = await runResearch(request, deps);
      expect(report.identity.status).toBe("not_found");
      expect(report.identity.primaryCandidateId).toBeNull();
      expect(report.warnings.map((w) => w.code)).toContain("identity_not_found");
      expect(report.risk.overall.level).toBe("unknown");
      expect(await perfloTotalFor(report, real)).toBe(parseMoney(report.costs.total.amount));
    },
    180_000,
  );
});

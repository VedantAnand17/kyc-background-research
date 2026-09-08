// Typed Perflo v1 client. PRD.md section 10.
// Adapted from perflo-quickstart/src/perflo.ts: fetch only, one method per endpoint,
// unwrap `data`, turn `error` into PerfloError. Never retry a pay call blind.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PerfloError } from "./errors.js";
import type { PayResult, Transaction, VendorContract, VendorSearchResult } from "./types.js";

export interface PayArgs {
  readonly input?: Record<string, unknown>;
  readonly query?: Record<string, unknown>;
  readonly maxCharge: PerfloMoneyLike;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

interface PerfloMoneyLike {
  readonly amount: string;
  readonly currency: string;
}

export interface PerfloClient {
  getVendor(slug: string): Promise<VendorContract>;
  search(query: string, opts?: { readonly capability?: string; readonly limit?: number }): Promise<VendorSearchResult[]>;
  pay(slug: string, args: PayArgs): Promise<PayResult>;
  getTransaction(id: string): Promise<Transaction>;
  listTransactions(opts?: { readonly limit?: number }): Promise<Transaction[]>;
  /** GET /v1/tasks/:runId: the recorded outcome of a pay that answered 202 running. Same shape as a pay result. */
  getTask(runId: string): Promise<PayResult>;
  /**
   * GET /v1/key: the agent key's own envelope and remaining windows. The pre-flight uses this, not
   * GET /v1/balance, because Perflo answers `/v1/balance` with ACCOUNT_KEY_REQUIRED for an agent key
   * (2026-09-08 funded run) and the service always runs on an agent key.
   */
  getKey(): Promise<unknown>;
}

export interface PerfloClientOptions {
  readonly baseUrl: string;
  readonly agentKey: string;
  readonly timeoutMs: number;
}

interface Envelope<T> {
  data?: T;
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
  meta?: { requestId?: string };
  status?: string;
  code?: string;
  message?: string;
}

function isAbortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/**
 * The 202 body a slow vendor returns from POST /v1/pay and GET /v1/tasks/:id while still running.
 * Observed live 2026-09-08: `{runId, status: "running", terminal: false, chargeIsFinal: false, createdAt}`;
 * some deployments spell the id `id` and add `poll`, so both are accepted.
 */
interface RunningTask {
  readonly runId?: string;
  readonly id?: string;
  readonly status: "running" | "indeterminate" | string;
  readonly terminal: false;
  readonly poll?: { readonly url: string; readonly afterMs?: number };
}

function isRunning(value: PayResult | RunningTask): value is RunningTask {
  if (value.terminal !== false) return false;
  const task = value as RunningTask;
  return typeof (task.runId ?? task.id) === "string" && !("transactionId" in value && (value as PayResult).charged);
}

function runIdOf(task: RunningTask): string {
  return (task.runId ?? task.id)!;
}

/** Abort while polling still names the run, so the caller holds the reservation against it instead of losing the charge. */
function sleep(ms: number, signal: AbortSignal | undefined, runId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new PerfloError("TIMEOUT", `pay aborted while vendor task ${runId} was still running.`, 0, { runId }, undefined));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createPerfloClient(opts: PerfloClientOptions): PerfloClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs;

  async function envelope<T>(
    method: string,
    path: string,
    body?: unknown,
    extra?: {
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
      readonly auth?: boolean;
      readonly pollable?: boolean;
    },
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (extra?.auth !== false) headers.Authorization = `Bearer ${opts.agentKey}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (extra?.idempotencyKey) headers["Idempotency-Key"] = extra.idempotencyKey;

    const signals = [AbortSignal.timeout(timeoutMs)];
    if (extra?.signal) signals.push(extra.signal);

    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.any(signals),
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, init);
    } catch (err) {
      if (isAbortLike(err)) {
        throw new PerfloError("TIMEOUT", `${method} ${path} timed out after ${timeoutMs}ms.`, 0, undefined, undefined);
      }
      throw new PerfloError(
        "NETWORK_ERROR",
        `Could not reach ${baseUrl}. Check PERFLO_BASE_URL and your connection.`,
        0,
        undefined,
        undefined,
      );
    }

    const text = await res.text();
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // A 5xx HTML page from a gateway is not a free refusal. Hold and reconcile.
        throw new PerfloError(
          res.status >= 500 ? "INTERNAL_ERROR" : "INVALID_REQUEST",
          `${method} ${path} returned status ${res.status} and a body that is not JSON.`,
          res.status,
          { body: text.slice(0, 500) },
          undefined,
        );
      }
    }

    const env = parsed as Envelope<T>;
    const requestId = env.meta?.requestId;
    // A slow vendor answers { runId, status: "running", terminal: false } with nothing charged yet, as a 200
    // or a 202; that is a task to poll, not a confirm-first pause (2026-09-08 funded run).
    if (extra?.pollable && env.data && isRunning(env.data as unknown as PayResult | RunningTask)) {
      return env.data as T;
    }
    const pending = res.status === 202 || env.status === "pending_confirmation";
    if (pending || !res.ok || env.error) {
      const details = { ...(env.error?.details ?? {}) };
      const retryAfter = res.headers.get("Retry-After") ?? res.headers.get("RateLimit-Reset");
      if (retryAfter) details.retryAfter = retryAfter;
      const named = env.error?.code ?? env.code;
      const fallback = pending ? "CONFIRMATION_REQUIRED" : res.status >= 500 ? "INTERNAL_ERROR" : `HTTP_${res.status}`;
      throw new PerfloError(
        named ?? fallback,
        env.error?.message ?? env.message ?? `${method} ${path} failed with status ${res.status}.`,
        res.status,
        Object.keys(details).length > 0 ? details : undefined,
        requestId,
      );
    }
    return env.data as T;
  }

  return {
    getVendor(slug) {
      return envelope<VendorContract>("GET", `/v1/vendors/${encodeURIComponent(slug)}`, undefined, { auth: false });
    },
    search(query, searchOpts) {
      const body: Record<string, unknown> = { query };
      if (searchOpts?.capability !== undefined) body.capability = searchOpts.capability;
      if (searchOpts?.limit !== undefined) body.limit = searchOpts.limit;
      return envelope<VendorSearchResult[]>("POST", "/v1/search", body);
    },
    async pay(slug, args) {
      const body: Record<string, unknown> = { maxCharge: args.maxCharge };
      if (args.input !== undefined) body.input = args.input;
      if (args.query !== undefined) body.query = args.query;
      const started = Date.now();
      const signalOf = () => (args.signal ? { signal: args.signal } : {});
      let result = await envelope<PayResult | RunningTask>("POST", `/v1/pay/${encodeURIComponent(slug)}`, body, {
        idempotencyKey: args.idempotencyKey,
        pollable: true,
        ...signalOf(),
      });
      // The whole pay, initial call plus polling, shares one timeoutMs budget. Past it the caller holds the
      // reservation against the run id and reconciles through getTask, exactly as for a transport timeout.
      while (isRunning(result)) {
        const remaining = started + timeoutMs - Date.now();
        const wait = Math.min(Math.max(result.poll?.afterMs ?? 3_000, 1_000), Math.max(remaining, 0));
        if (remaining <= 0 || wait <= 0) {
          throw new PerfloError(
            "TIMEOUT",
            `POST /v1/pay/${slug} is still running after ${timeoutMs}ms; poll ${runIdOf(result)}.`,
            0,
            { runId: runIdOf(result) },
            undefined,
          );
        }
        await sleep(wait, args.signal, runIdOf(result));
        result = await envelope<PayResult | RunningTask>("GET", result.poll?.url ?? `/v1/tasks/${runIdOf(result)}`, undefined, {
          pollable: true,
          ...signalOf(),
        });
      }
      return result;
    },
    getTask(runId) {
      return envelope<PayResult>("GET", `/v1/tasks/${encodeURIComponent(runId)}`);
    },
    getTransaction(id) {
      return envelope<Transaction>("GET", `/v1/transactions/${encodeURIComponent(id)}`);
    },
    listTransactions(listOpts) {
      const q = new URLSearchParams();
      if (listOpts?.limit !== undefined) q.set("limit", String(listOpts.limit));
      const suffix = q.size > 0 ? `?${q.toString()}` : "";
      return envelope<Transaction[]>("GET", `/v1/transactions${suffix}`);
    },
    getKey() {
      return envelope<unknown>("GET", "/v1/key");
    },
  };
}

/** Serve recorded responses from test/fixtures when FIXTURE_MODE=true. Layout: test/fixtures/README.md. */
export function createFixturePerfloClient(root: string): PerfloClient {
  const read = (rel: string): unknown => {
    const path = join(root, rel);
    try {
      return JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      throw new Error(`missing fixture: ${path}`);
    }
  };
  const unwrap = <T>(raw: unknown): T => {
    if (raw && typeof raw === "object" && "data" in raw) return (raw as { data: T }).data;
    return raw as T;
  };

  return {
    async getVendor(slug) {
      return unwrap<VendorContract>(read(`vendors/${slug}.contract.json`));
    },
    async search(query) {
      const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "empty";
      return unwrap<VendorSearchResult[]>(read(`search/${slug}.json`));
    },
    async pay(slug) {
      return unwrap<PayResult>(read(`pay/${slug}/succeeded.json`));
    },
    async getTransaction(id) {
      return unwrap<Transaction>(read(`transactions/${id}.json`));
    },
    async getTask(runId) {
      return unwrap<PayResult>(read(`tasks/${runId}.json`));
    },
    async listTransactions() {
      return unwrap<Transaction[]>(read("transactions/list.json"));
    },
    async getKey() {
      return unwrap<unknown>(read("key.json"));
    },
  };
}

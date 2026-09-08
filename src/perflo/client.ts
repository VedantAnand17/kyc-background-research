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
  getBalance(): Promise<unknown>;
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

export function createPerfloClient(opts: PerfloClientOptions): PerfloClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs;

  async function envelope<T>(
    method: string,
    path: string,
    body?: unknown,
    extra?: { readonly idempotencyKey?: string; readonly signal?: AbortSignal; readonly auth?: boolean },
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
        throw new PerfloError(
          "INVALID_REQUEST",
          `${method} ${path} returned status ${res.status} and a body that is not JSON.`,
          res.status,
          { body: text.slice(0, 500) },
          undefined,
        );
      }
    }

    const env = parsed as Envelope<T>;
    const requestId = env.meta?.requestId;
    const pending = res.status === 202 || env.status === "pending_confirmation";
    if (pending || !res.ok || env.error) {
      const details = { ...(env.error?.details ?? {}) };
      const retryAfter = res.headers.get("Retry-After") ?? res.headers.get("RateLimit-Reset");
      if (retryAfter) details.retryAfter = retryAfter;
      throw new PerfloError(
        env.error?.code ?? env.code ?? (pending ? "CONFIRMATION_REQUIRED" : `HTTP_${res.status}`),
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
    pay(slug, args) {
      const body: Record<string, unknown> = { maxCharge: args.maxCharge };
      if (args.input !== undefined) body.input = args.input;
      if (args.query !== undefined) body.query = args.query;
      return envelope<PayResult>(
        "POST",
        `/v1/pay/${encodeURIComponent(slug)}`,
        body,
        args.signal
          ? { idempotencyKey: args.idempotencyKey, signal: args.signal }
          : { idempotencyKey: args.idempotencyKey },
      );
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
    getBalance() {
      return envelope<unknown>("GET", "/v1/balance");
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
    async listTransactions() {
      return unwrap<Transaction[]>(read("transactions/list.json"));
    },
    async getBalance() {
      return unwrap<unknown>(read("balance.json"));
    },
  };
}

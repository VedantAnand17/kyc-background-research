// In-process fake of the Perflo v1 API for tests. PRD.md section 16.
// Hono on an ephemeral port. Every documented pay outcome is addressable as scenario-<code>.
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import type { PayResult, PerfloMoney, Transaction, VendorContract, VendorField, VendorSearchResult } from "../src/perflo/types.js";

export type FakePayScenario =
  | "succeeded"
  | "failed"
  | "MAX_CHARGE_EXCEEDED"
  | "SCHEMA_VALIDATION_FAILED"
  | "VALIDATION_ERROR"
  | "VENDOR_NOT_PAYABLE"
  | "VENDOR_NOT_FOUND"
  | "GUARDRAIL_DENIED"
  | "INSUFFICIENT_BALANCE"
  | "VENDOR_ERROR"
  | "pending_confirmation"
  | "SETTLEMENT_RECORDING_FAILED"
  | "RATE_LIMITED"
  | "hang"
  | "html-502"
  | "opaque-502";

export interface FakePayCall {
  readonly slug: string;
  readonly body: unknown;
  readonly idempotencyKey: string | null;
}

export interface FakePerflo {
  readonly baseUrl: string;
  readonly payCalls: FakePayCall[];
  setScenario(slug: string, scenario: FakePayScenario): void;
  setContract(slug: string, patch: Partial<VendorContract>): void;
  setPayable(slug: string, payable: boolean): void;
  setSearchResults(query: string, results: VendorSearchResult[]): void;
  setPayOutput(slug: string, output: unknown): void;
  close(): Promise<void>;
}

const MONEY: PerfloMoney = { amount: "0.025200", currency: "USD" };

function fieldsFor(slug: string): { fields: VendorField[] } {
  const body = (name: string, required = false) => ({ name, in: "body" as const, required, type: "string" });
  if (slug.includes("minerva") || slug.includes("fullenrich-people") || slug.includes("pdl") || slug.includes("skip-trace")) {
    return { fields: [body("fullName", true), body("locationHint"), body("company"), body("location"), body("city"), body("region"), body("profileUrl")] };
  }
  if (slug.includes("linkedin") || slug.includes("harvest") || slug.includes("apimaestro")) {
    return { fields: [body("profileUrl"), body("fullName"), body("company")] };
  }
  if (slug.includes("twitter") || slug.includes("instagram")) {
    return { fields: [body("handleOrName", true), body("network")] };
  }
  if (slug.includes("edgar") || slug.includes("filing")) {
    return { fields: [body("fullName", true)] };
  }
  if (slug.includes("firecrawl") || slug.includes("scrape")) {
    return { fields: [body("url", true)] };
  }
  if (slug.includes("watchlist") || slug.includes("sanction") || slug.includes("pep")) {
    return { fields: [body("fullName", true), body("dateOfBirth"), body("country")] };
  }
  return { fields: [body("query", true)] };
}

function contract(slug: string, patches: Map<string, Partial<VendorContract>>, payable: Map<string, boolean>): VendorContract {
  const patch = patches.get(slug);
  const input = patch?.input ?? fieldsFor(slug);
  return {
    slug: patch?.slug ?? slug,
    name: patch?.name ?? `Fake ${slug}`,
    description: patch?.description ?? "In-process fake vendor.",
    capability: patch?.capability ?? "web_search",
    price: patch?.price ?? MONEY,
    maxChargePerCall: patch?.maxChargePerCall ?? MONEY,
    pricingUnit: patch?.pricingUnit ?? "call",
    payable: patch?.payable ?? payable.get(slug) ?? true,
    input,
  };
}

function searchRow(slug: string): VendorSearchResult {
  return {
    slug,
    name: `Fake ${slug}`,
    description: "In-process fake vendor.",
    capability: "web_search",
    price: MONEY,
    maxChargePerCall: MONEY,
    pricingUnit: "call",
    isPrimary: true,
    payable: true,
  };
}

function payOk(slug: string, status: "succeeded" | "failed", transactionId: string, output?: unknown): PayResult {
  const result: PayResult = {
    transactionId,
    slug,
    status,
    terminal: true,
    charged: MONEY,
    chargeIsFinal: true,
    chargedTo: "credit",
    remaining: { amount: "4.720000", currency: "USD" },
    upstream: { httpStatus: status === "succeeded" ? 200 : 500 },
  };
  if (status === "succeeded") return { ...result, output: output ?? { results: [] } };
  return { ...result, failure: { reason: "vendor_failed", message: "vendor answered and failed" } };
}

function transactionRow(id: string, slug: string, status: string, idempotencyKey?: string | null): Transaction {
  return {
    id,
    kind: "payment",
    status,
    ledgerState: "posted",
    terminal: true,
    slug,
    capability: "web_search",
    amount: { amount: "-0.025200", currency: "USD" },
    createdAt: "2026-09-08T10:00:00.000Z",
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

function fail(c: { json: (body: unknown, status: number) => Response }, status: number, code: string) {
  return c.json({ error: { code, message: code }, meta: { requestId: "fake-req" } }, status);
}

function scenarioOf(slug: string, overrides: Map<string, FakePayScenario>): FakePayScenario {
  const override = overrides.get(slug);
  if (override) return override;
  if (slug.startsWith("scenario-")) return slug.slice("scenario-".length) as FakePayScenario;
  return "succeeded";
}

export async function startFakePerflo(): Promise<FakePerflo> {
  const scenarios = new Map<string, FakePayScenario>();
  const contractPatches = new Map<string, Partial<VendorContract>>();
  const payableBySlug = new Map<string, boolean>();
  const searchByQuery = new Map<string, VendorSearchResult[]>();
  const payOutputs = new Map<string, unknown>();
  const payCalls: FakePayCall[] = [];
  const idempotency = new Map<string, { status: number; body: unknown; headers?: Record<string, string> }>();
  const transactions = new Map<string, Transaction>();
  const hangTimers: ReturnType<typeof setTimeout>[] = [];
  let paySeq = 0;

  const app = new Hono();

  app.get("/v1/vendors/:slug", (c) => {
    const slug = c.req.param("slug");
    if (scenarioOf(slug, scenarios) === "VENDOR_NOT_FOUND") {
      return fail(c, 404, "VENDOR_NOT_FOUND");
    }
    return c.json({ data: contract(slug, contractPatches, payableBySlug), meta: { requestId: "fake-req" } });
  });

  app.post("/v1/search", async (c) => {
    if (!c.req.header("Authorization")?.startsWith("Bearer ")) return fail(c, 401, "UNAUTHENTICATED");
    const body = (await c.req.json().catch(() => ({}))) as { query?: unknown };
    const query = typeof body.query === "string" ? body.query : "";
    const override = searchByQuery.get(query);
    const data = override ?? [searchRow("demo-vendor")];
    return c.json({ data, meta: { requestId: "fake-req", total: data.length } });
  });

  app.get("/v1/balance", (c) => {
    if (!c.req.header("Authorization")?.startsWith("Bearer ")) return fail(c, 401, "UNAUTHENTICATED");
    return c.json({
      data: { spendable: { amount: "4.72", currency: "USD" }, asOf: "2026-09-08T10:00:00.000Z" },
      meta: { requestId: "fake-req" },
    });
  });

  app.get("/v1/transactions/:id", (c) => {
    if (!c.req.header("Authorization")?.startsWith("Bearer ")) return fail(c, 401, "UNAUTHENTICATED");
    const row = transactions.get(c.req.param("id"));
    if (!row) return fail(c, 404, "TRANSACTION_NOT_FOUND");
    return c.json({ data: row, meta: { requestId: "fake-req" } });
  });

  app.get("/v1/transactions", (c) => {
    if (!c.req.header("Authorization")?.startsWith("Bearer ")) return fail(c, 401, "UNAUTHENTICATED");
    const limit = Number(c.req.query("limit") ?? "50");
    const rows = [...transactions.values()].slice(0, Number.isFinite(limit) ? limit : 50);
    return c.json({ data: rows, meta: { requestId: "fake-req", total: transactions.size } });
  });

  app.post("/v1/pay/:slug", async (c) => {
    if (!c.req.header("Authorization")?.startsWith("Bearer ")) return fail(c, 401, "UNAUTHENTICATED");
    const slug = c.req.param("slug");
    const idempotencyKey = c.req.header("Idempotency-Key") ?? null;
    const body = await c.req.json().catch(() => ({}));
    payCalls.push({ slug, body, idempotencyKey });

    if (idempotencyKey && idempotency.has(idempotencyKey)) {
      const first = idempotency.get(idempotencyKey)!;
      if (first.headers) {
        for (const [key, value] of Object.entries(first.headers)) c.header(key, value);
      }
      return c.json(first.body, first.status as 200);
    }

    const scenario = scenarioOf(slug, scenarios);
    const remember = (status: number, payload: unknown, headers?: Record<string, string>) => {
      if (idempotencyKey) {
        const stored = headers ? { status, body: payload, headers } : { status, body: payload };
        idempotency.set(idempotencyKey, stored);
      }
      if (headers) {
        for (const [key, value] of Object.entries(headers)) c.header(key, value);
      }
      return c.json(payload, status as 200);
    };

    if (scenario === "html-502") {
      return c.body("<html>Bad Gateway</html>", 502);
    }
    if (scenario === "opaque-502") {
      return remember(502, { message: "upstream blew up" });
    }

    if (scenario === "hang") {
      paySeq += 1;
      const id = `tx-${paySeq}`;
      transactions.set(id, transactionRow(id, slug, "succeeded", idempotencyKey));
      await new Promise<void>((resolve) => {
        hangTimers.push(setTimeout(resolve, 30_000));
      });
      return remember(200, { data: payOk(slug, "succeeded", id, payOutputs.get(slug)), meta: { requestId: "fake-req" } });
    }

    const charged: FakePayScenario[] = ["succeeded", "failed", "SETTLEMENT_RECORDING_FAILED"];
    if (charged.includes(scenario)) {
      paySeq += 1;
      const id = `tx-${paySeq}`;
      const status = scenario === "failed" ? "failed" : "succeeded";
      transactions.set(id, transactionRow(id, slug, status, idempotencyKey));
      if (scenario === "SETTLEMENT_RECORDING_FAILED") {
        return remember(500, { error: { code: "SETTLEMENT_RECORDING_FAILED", message: "bookkeeping failed" }, meta: { requestId: "fake-req" } });
      }
      return remember(200, { data: payOk(slug, status, id, payOutputs.get(slug)), meta: { requestId: "fake-req" } });
    }

    switch (scenario) {
      case "MAX_CHARGE_EXCEEDED":
        return remember(422, { error: { code: "MAX_CHARGE_EXCEEDED", message: "maxCharge too low" }, meta: { requestId: "fake-req" } });
      case "SCHEMA_VALIDATION_FAILED":
        return remember(422, { error: { code: "SCHEMA_VALIDATION_FAILED", message: "schema" }, meta: { requestId: "fake-req" } });
      case "VALIDATION_ERROR":
        return remember(422, { error: { code: "VALIDATION_ERROR", message: "validation" }, meta: { requestId: "fake-req" } });
      case "VENDOR_NOT_PAYABLE":
        return remember(403, { error: { code: "VENDOR_NOT_PAYABLE", message: "not payable" }, meta: { requestId: "fake-req" } });
      case "VENDOR_NOT_FOUND":
        return remember(404, { error: { code: "VENDOR_NOT_FOUND", message: "missing" }, meta: { requestId: "fake-req" } });
      case "GUARDRAIL_DENIED":
        return remember(403, { error: { code: "GUARDRAIL_DENIED", message: "envelope" }, meta: { requestId: "fake-req" } });
      case "INSUFFICIENT_BALANCE":
        return remember(402, { error: { code: "INSUFFICIENT_BALANCE", message: "empty" }, meta: { requestId: "fake-req" } });
      case "VENDOR_ERROR":
        return remember(502, { error: { code: "VENDOR_ERROR", message: "upstream" }, meta: { requestId: "fake-req" } });
      case "pending_confirmation":
        return remember(202, {
          status: "pending_confirmation",
          code: "CONFIRMATION_REQUIRED",
          message: "confirm-first",
          meta: { requestId: "fake-req" },
        });
      case "RATE_LIMITED":
        return remember(
          429,
          { error: { code: "RATE_LIMITED", message: "slow down" }, meta: { requestId: "fake-req" } },
          { "Retry-After": "2", "RateLimit-Reset": "2" },
        );
      default:
        return remember(500, { error: { code: "INTERNAL_ERROR", message: "unknown scenario" }, meta: { requestId: "fake-req" } });
    }
  });

  const server = createServer(getRequestListener(app.fetch));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("fake Perflo failed to bind");

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    payCalls,
    setScenario(slug, scenario) {
      scenarios.set(slug, scenario);
    },
    setContract(slug, patch) {
      contractPatches.set(slug, patch);
    },
    setPayable(slug, payable) {
      payableBySlug.set(slug, payable);
    },
    setSearchResults(query, results) {
      searchByQuery.set(query, results);
    },
    setPayOutput(slug, output) {
      payOutputs.set(slug, output);
    },
    close() {
      for (const t of hangTimers) clearTimeout(t);
      return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

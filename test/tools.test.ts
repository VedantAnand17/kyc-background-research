import { afterEach, describe, expect, it } from "vitest";
import { createSpendGuard } from "../src/budget/ledger.js";
import { createEvidenceStore } from "../src/evidence/store.js";
import { openDatabase, type Db } from "../src/db/sqlite.js";
import { createPerfloClient } from "../src/perflo/client.js";
import { CAPABILITIES, type ToolName } from "../src/research/capabilities.js";
import { createTools, type ToolContext, type ToolOutcome } from "../src/research/tools.js";
import { startFakePerflo, type FakePerflo } from "./fake-perflo.js";

const PAID_TOOLS = CAPABILITIES.map((c) => c.tool).filter((name): name is Exclude<ToolName, "finish"> => name !== "finish");

const ARGS: Record<Exclude<ToolName, "finish">, Record<string, unknown>> = {
  find_people: { fullName: "Ada Okonkwo", locationHint: "Lagos" },
  get_professional_profile: { fullName: "Ada Okonkwo", company: "Paystack" },
  search_news: { query: "Ada Okonkwo Lagos" },
  screen_watchlist: { fullName: "Ada Okonkwo", country: "NG" },
  enrich_person: { fullName: "Ada Okonkwo", company: "Paystack", location: "Lagos" },
  get_social_profile: { network: "x", handleOrName: "ada" },
  search_web: { query: "Ada Okonkwo Paystack" },
  skip_trace: { fullName: "Ada Okonkwo", city: "Lagos", region: "Lagos" },
  search_filings: { fullName: "Ada Okonkwo" },
  fetch_page: { url: "https://example.com/ada" },
};

const dbs: Db[] = [];
const fakes: FakePerflo[] = [];

afterEach(async () => {
  for (const db of dbs) db.close();
  dbs.length = 0;
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

async function harness(over: { capMicro?: bigint; allowed?: readonly ToolName[] } = {}) {
  const server = await startFakePerflo();
  fakes.push(server);
  const db = openDatabase(":memory:");
  const jobId = "job-1";
  db.prepare(
    `INSERT INTO jobs (id, created_at, tier, cap_micro, spent_micro, status, request_json)
     VALUES (?, ?, 'deep', ?, '0', 'running', '{}')`,
  ).run(jobId, new Date().toISOString(), (over.capMicro ?? 10_000_000n).toString());
  dbs.push(db);
  const guard = createSpendGuard({
    db,
    jobId,
    capMicro: over.capMicro ?? 10_000_000n,
    reserveMicro: 0n,
  });
  const ctx: ToolContext = {
    jobId,
    client: createPerfloClient({ baseUrl: server.baseUrl, agentKey: "perflo_test_fake", timeoutMs: 2_000 }),
    guard,
    store: createEvidenceStore(db, jobId),
    allowedTools: over.allowed ?? CAPABILITIES.map((c) => c.tool),
    signal: new AbortController().signal,
    concurrency: 4,
  };
  return { server, tools: createTools(ctx), ctx };
}

async function call(
  tools: ReturnType<typeof createTools>,
  name: Exclude<ToolName, "finish">,
  args: Record<string, unknown> = ARGS[name],
): Promise<ToolOutcome> {
  const tool = tools[name];
  if (!tool?.execute) throw new Error(`missing tool ${name}`);
  return tool.execute(args);
}

describe("tool layer", () => {
  it("calls every capability against the fake server", async () => {
    const { server, tools } = await harness();
    for (const name of PAID_TOOLS) {
      const result = await call(tools, name);
      expect(result.outcome, name).toBe("ok");
      if (result.outcome !== "ok") continue;
      expect(result.cached, name).toBe(false);
      expect(result.sourceId, name).toMatch(/\w/);
      expect(result.summary.length, name).toBeGreaterThan(0);
      expect(result.summary.length, name).toBeLessThanOrEqual(1_500);
      expect(result.charged, name).toBe("0.025200");
    }
    expect(server.payCalls.length).toBe(PAID_TOOLS.length);
  });

  it("serves a repeat call from cache at zero charge", async () => {
    const { server, tools, ctx } = await harness();
    const first = await call(tools, "find_people");
    const second = await call(tools, "find_people");
    expect(first.outcome).toBe("ok");
    expect(second).toMatchObject({
      outcome: "ok",
      cached: true,
      charged: "0.000000",
      sourceId: first.outcome === "ok" ? first.sourceId : "",
    });
    expect(server.payCalls).toHaveLength(1);
    expect(ctx.guard.snapshot().spentMicro).toBe(25_200n);
    expect(ctx.store.forJob()).toHaveLength(1);
  });

  it("places fields from the vendor contract in, never by guessing", async () => {
    const { server, tools } = await harness();
    server.setContract("ottoai-filtered-news", {
      input: {
        fields: [
          { name: "query", in: "query", required: true, type: "string" },
          { name: "fullName", in: "body", required: false, type: "string" },
        ],
      },
    });
    const result = await call(tools, "search_news", { query: "Ada Okonkwo" });
    expect(result.outcome).toBe("ok");
    expect(server.payCalls[0]?.body).toMatchObject({
      query: { query: "Ada Okonkwo" },
      maxCharge: { amount: "0.025200", currency: "USD" },
    });
    expect(server.payCalls[0]?.body).not.toHaveProperty("input.query");
  });

  it("falls back to the next payable vendor when the first is unpayable", async () => {
    const { server, tools } = await harness();
    server.setPayable("stableenrich-minerva-resolve", false);
    const result = await call(tools, "find_people");
    expect(result.outcome).toBe("ok");
    expect(server.payCalls[0]?.slug).toBe("stableenrich-fullenrich-people-search");
  });

  it("returns budget_exhausted when the quote does not fit headroom", async () => {
    const { tools, server } = await harness({ capMicro: 1_000n });
    const result = await call(tools, "find_people");
    expect(result).toEqual({ outcome: "budget_exhausted", remaining: "0.001000" });
    expect(server.payCalls).toHaveLength(0);
    const again = await call(tools, "search_news");
    expect(again.outcome).toBe("budget_exhausted");
  });

  it("refuses only the unaffordable tool while a cheaper allowed quote still fits", async () => {
    const { tools, server } = await harness({ capMicro: 50_000n });
    server.setContract("stableenrich-pdl-people-enrich", {
      maxChargePerCall: { amount: "0.280000", currency: "USD" },
    });
    const enrich = await call(tools, "enrich_person");
    expect(enrich).toEqual({ outcome: "budget_exhausted", remaining: "0.050000" });
    expect(server.payCalls).toHaveLength(0);
    const news = await call(tools, "search_news");
    expect(news.outcome).toBe("ok");
    if (news.outcome !== "ok") return;
    expect(news.cached).toBe(false);
    expect(news.charged).toBe("0.025200");
    expect(server.payCalls).toHaveLength(1);
    expect(server.payCalls[0]?.slug).toBe("ottoai-filtered-news");
  });

  it("reports unavailable when discovery finds no payable watchlist vendor", async () => {
    const { server, tools } = await harness();
    server.setSearchResults("PEP sanctions watchlist screening", []);
    const result = await call(tools, "screen_watchlist");
    expect(result.outcome).toBe("unavailable");
    if (result.outcome === "unavailable") {
      expect(result.reason).toMatch(/watchlist/i);
    }
    expect(server.payCalls).toHaveLength(0);
  });

  it("finish does not pay", async () => {
    const { server, tools } = await harness();
    const finish = tools.finish;
    if (!finish?.execute) throw new Error("missing finish");
    const result = await finish.execute({});
    expect(result.outcome).toBe("ok");
    expect(server.payCalls).toHaveLength(0);
  });
});

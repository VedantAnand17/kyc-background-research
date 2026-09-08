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
  get_professional_profile: { profileUrl: "https://www.linkedin.com/in/ada-okonkwo", company: "Paystack" },
  search_news: { query: "Ada Okonkwo Lagos" },
  screen_watchlist: { fullName: "Ada Okonkwo", country: "NG" },
  enrich_person: { profileUrl: "https://www.linkedin.com/in/ada-okonkwo", fullName: "Ada Okonkwo", location: "Lagos" },
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

  it("dedupes enrich_person by the profile, not by optional argument text", async () => {
    const { server, tools, ctx } = await harness();
    const first = await call(tools, "enrich_person", {
      profileUrl: "https://www.linkedin.com/in/ada-okonkwo",
      location: "Lagos",
    });
    const second = await call(tools, "enrich_person", {
      profileUrl: "https://www.linkedin.com/in/Ada-Okonkwo/",
      fullName: "Ada Okonkwo",
      company: "Paystack",
      location: "Lagos, Nigeria",
    });
    expect(first.outcome).toBe("ok");
    expect(second).toMatchObject({
      outcome: "ok",
      cached: true,
      charged: "0.000000",
      sourceId: first.outcome === "ok" ? first.sourceId : "",
    });
    expect(server.payCalls).toHaveLength(1);
    expect(ctx.guard.snapshot().spentMicro).toBe(25_200n);
  });

  it("places fields from the vendor contract when no adapter owns the vendor", async () => {
    const { server, tools } = await harness();
    server.setContract("stableenrich-firecrawl-scrape", {
      input: {
        fields: [
          { name: "url", in: "query", required: true, type: "string" },
          { name: "fullName", in: "body", required: false, type: "string" },
        ],
      },
    });
    const result = await call(tools, "fetch_page", { url: "https://example.com/ada" });
    expect(result.outcome).toBe("ok");
    expect(server.payCalls[0]?.body).toMatchObject({
      query: { url: "https://example.com/ada" },
      maxCharge: { amount: "0.025200", currency: "USD" },
    });
    expect(server.payCalls[0]?.body).not.toHaveProperty("input.url");
  });

  it("sends each live vendor the body its real contract takes, not the model-facing argument names", async () => {
    const { server, tools } = await harness();
    await call(tools, "find_people");
    await call(tools, "get_professional_profile");
    await call(tools, "search_news");
    await call(tools, "enrich_person");
    await call(tools, "skip_trace");
    await call(tools, "search_filings");
    const bodies = Object.fromEntries(server.payCalls.map((c) => [c.slug, (c.body as { input?: unknown }).input]));
    expect(bodies["stableenrich-exa-search"]).toMatchObject({ query: "Ada Okonkwo Lagos", category: "linkedin profile" });
    expect(bodies["apify-apimaestro-linkedin-profile-detail"]).toMatchObject({ username: "ada-okonkwo" });
    expect(bodies["stableenrich-serper-news"]).toMatchObject({ q: "Ada Okonkwo Lagos" });
    expect(bodies["apify-anchor-linkedin-profile-enrichment"]).toEqual({
      startUrls: [{ url: "https://www.linkedin.com/in/ada-okonkwo" }],
    });
    expect(bodies["apify-one-api-skip-trace"]).toEqual({ name: ["Ada Okonkwo;Lagos, Lagos"], max_results: 3 });
    expect(bodies["paysponge-edgar-search"]).toMatchObject({ q: '"Ada Okonkwo"' });
  });

  it("refuses to pay a vendor whose adapter cannot be satisfied and releases the reservation", async () => {
    const { server, tools, ctx } = await harness();
    server.setContract("stableenrich-exa-search", { payable: false });
    server.setContract("stableenrich-exa-search-tempo", { payable: false });
    const result = await call(tools, "search_web", { query: "" });
    expect(result.outcome).toBe("invalid_args");
    expect(server.payCalls).toHaveLength(0);
    expect(ctx.guard.snapshot().spentMicro).toBe(0n);
  });

  it("settles a per-item vendor at the authorization Perflo debits, not the metered charge it reports", async () => {
    const { server, tools, ctx } = await harness();
    // Live shape (2026-09-08): apimaestro lists price $0.005 and cap $0.05, meters $0.0065, and the account is
    // debited $0.05 with settlement.status "not_required". A finalized vendor is debited exactly what it meters.
    server.setContract("apify-apimaestro-linkedin-profile-detail", {
      price: { amount: "0.005000", currency: "USD" },
      maxChargePerCall: { amount: "0.050000", currency: "USD" },
    });
    server.setContract("stableenrich-serper-news", {
      price: { amount: "0.040000", currency: "USD" },
      maxChargePerCall: { amount: "0.040000", currency: "USD" },
    });
    const profile = await call(tools, "get_professional_profile");
    expect(profile.outcome).toBe("ok");
    if (profile.outcome === "ok") expect(profile.charged).toBe("0.050000");
    const news = await call(tools, "search_news");
    if (news.outcome === "ok") expect(news.charged).toBe("0.040000");
    expect(ctx.guard.snapshot().spentMicro).toBe(90_000n);
  });

  it("discovery ignores catalog hits whose capability does not fit the tool", async () => {
    const { server, tools } = await harness();
    server.setSearchResults("PEP sanctions watchlist screening", [
      {
        slug: "apify-some-stock-screener",
        name: "Stock screener",
        description: "Scans stock markets.",
        capability: "company",
        price: { amount: "0.05", currency: "USD" },
        maxChargePerCall: { amount: "0.50", currency: "USD" },
        pricingUnit: "item",
        isPrimary: false,
        payable: true,
      },
    ]);
    const result = await call(tools, "screen_watchlist");
    expect(result.outcome).toBe("unavailable");
    expect(server.payCalls).toHaveLength(0);
  });

  it("falls back to the next payable vendor when the first is unpayable", async () => {
    const { server, tools } = await harness();
    server.setPayable("stableenrich-exa-search", false);
    const result = await call(tools, "find_people");
    expect(result.outcome).toBe("ok");
    expect(server.payCalls[0]?.slug).toBe("stableenrich-exa-search-tempo");
  });

  it("retry after a released VENDOR_ERROR pays the fallback vendor instead of serving the failure from cache", async () => {
    const { server, tools } = await harness();
    server.setScenario("stableenrich-exa-search", "VENDOR_ERROR");
    const first = await call(tools, "find_people", { fullName: "Ada Okonkwo" });
    expect(first.outcome).toBe("failed");
    if (first.outcome === "failed") {
      expect(first.reason).toMatch(/upstream/i);
    }
    const second = await call(tools, "find_people", { fullName: "Ada Okonkwo" });
    expect(second).toMatchObject({ outcome: "ok", cached: false });
    expect(server.payCalls.map((c) => c.slug)).toEqual([
      "stableenrich-exa-search",
      "stableenrich-exa-search-tempo",
    ]);
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
    for (const slug of ["apify-anchor-linkedin-profile-enrichment", "apify-apimaestro-linkedin-profile-detail"]) {
      server.setContract(slug, { maxChargePerCall: { amount: "0.280000", currency: "USD" } });
    }
    const enrich = await call(tools, "enrich_person");
    expect(enrich).toEqual({ outcome: "budget_exhausted", remaining: "0.050000" });
    expect(server.payCalls).toHaveLength(0);
    const news = await call(tools, "search_news");
    expect(news.outcome).toBe("ok");
    if (news.outcome !== "ok") return;
    expect(news.cached).toBe(false);
    expect(news.charged).toBe("0.025200");
    expect(server.payCalls).toHaveLength(1);
    expect(server.payCalls[0]?.slug).toBe("stableenrich-serper-news");
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

  it("returns invalid_args to the caller when the model omits a required field", async () => {
    const { server, tools } = await harness();
    const result = await call(tools, "find_people", { locationHint: "Lagos" });
    expect(result.outcome).toBe("invalid_args");
    if (result.outcome === "invalid_args") {
      expect(result.issues.join(" ")).toMatch(/fullName/i);
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

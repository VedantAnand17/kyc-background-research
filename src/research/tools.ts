// Tool layer: the only module allowed to call PerfloClient.pay(). PRD.md section 9, ADR-0003.
import { z } from "zod";
import { formatMoney, parseMoney, toMoney, type Micro } from "../budget/money.js";
import type { SpendGuard } from "../budget/ledger.js";
import { extractFor } from "../evidence/extract.js";
import type { EvidenceStore } from "../evidence/store.js";
import type { PerfloClient } from "../perflo/client.js";
import { ledgerActionForError, PerfloError } from "../perflo/errors.js";
import type { VendorContract } from "../perflo/types.js";
import { capabilityOf, preferredVendors, type ToolName } from "./capabilities.js";

export interface ToolContext {
  readonly jobId: string;
  readonly client: PerfloClient;
  readonly guard: SpendGuard;
  readonly store: EvidenceStore;
  readonly allowedTools: readonly ToolName[];
  readonly signal: AbortSignal;
  readonly concurrency?: number;
}

export type ToolOutcome =
  | { readonly outcome: "ok"; readonly sourceId: string; readonly summary: string; readonly charged: string; readonly remaining: string; readonly cached: boolean }
  | { readonly outcome: "failed"; readonly sourceId: string | null; readonly reason: string; readonly charged: string; readonly remaining: string }
  | { readonly outcome: "budget_exhausted"; readonly remaining: string }
  | { readonly outcome: "unavailable"; readonly reason: string };

export interface ExecutableTool {
  readonly description: string;
  readonly inputSchema: z.ZodType;
  execute(args: Record<string, unknown>): Promise<ToolOutcome>;
}

export type ResearchTools = Partial<Record<ToolName, ExecutableTool>>;

type SelectedVendor =
  | { readonly status: "selected"; readonly slug: string; readonly contract: VendorContract; readonly quote: Micro }
  | { readonly status: "unaffordable" }
  | { readonly status: "none" };

const PURPOSE: Record<Exclude<ToolName, "finish">, string> = {
  find_people: "resolve candidates",
  get_professional_profile: "professional profile",
  search_news: "news",
  screen_watchlist: "watchlist screen",
  enrich_person: "person enrich",
  get_social_profile: "social profile",
  search_web: "web search",
  skip_trace: "skip trace",
  search_filings: "filings",
  fetch_page: "fetch page",
};

const ALIASES: Record<string, readonly string[]> = {
  name: ["fullName"],
  full_name: ["fullName"],
  query: ["query", "fullName", "handleOrName"],
  url: ["url", "profileUrl"],
  profile_url: ["profileUrl"],
  linkedin_url: ["profileUrl"],
  location: ["location", "locationHint"],
  city: ["city", "locationHint"],
  handle: ["handleOrName"],
  username: ["handleOrName"],
};

const FindPeopleArgs = z.object({
  fullName: z.string().trim().min(1),
  locationHint: z.string().trim().min(1).optional(),
});
const ProfessionalArgs = z
  .object({
    profileUrl: z.url().optional(),
    fullName: z.string().trim().min(1).optional(),
    company: z.string().trim().min(1).optional(),
  })
  .refine((v) => Boolean(v.profileUrl || v.fullName), { message: "profileUrl or fullName is required" });
const QueryArgs = z.object({ query: z.string().trim().min(1) });
const WatchlistArgs = z.object({
  fullName: z.string().trim().min(1),
  dateOfBirth: z.string().trim().min(1).optional(),
  country: z.string().trim().min(1).optional(),
});
const EnrichArgs = z.object({
  fullName: z.string().trim().min(1),
  company: z.string().trim().min(1).optional(),
  location: z.string().trim().min(1).optional(),
  profileUrl: z.string().trim().min(1).optional(),
});
const SocialArgs = z.object({
  network: z.enum(["x", "instagram"]),
  handleOrName: z.string().trim().min(1),
});
const SkipTraceArgs = z.object({
  fullName: z.string().trim().min(1),
  city: z.string().trim().min(1).optional(),
  region: z.string().trim().min(1).optional(),
});
const FilingsArgs = z.object({ fullName: z.string().trim().min(1) });
const FetchPageArgs = z.object({ url: z.url() });
const FinishArgs = z.object({});

class Limit {
  private active = 0;
  private readonly wait: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.wait.push(resolve));
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.wait.shift()?.();
    }
  }
}

class ContractCache {
  private readonly rows = new Map<string, { readonly contract: VendorContract; readonly at: number }>();
  constructor(
    private readonly client: PerfloClient,
    private readonly ttlMs = 60 * 60 * 1000,
  ) {}
  async get(slug: string): Promise<VendorContract> {
    const hit = this.rows.get(slug);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.contract;
    const contract = await this.client.getVendor(slug);
    this.rows.set(slug, { contract, at: Date.now() });
    return contract;
  }
  invalidate(slug: string): void {
    this.rows.delete(slug);
  }
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec).sort()) {
      const item = rec[key];
      if (item === undefined) continue;
      out[key] = typeof item === "string" ? item.trim() : sortDeep(item);
    }
    return out;
  }
  return value;
}

export function canonicalizeArgs(args: Record<string, unknown>): string {
  return JSON.stringify(sortDeep(args));
}

function readArg(field: string, args: Record<string, unknown>): unknown {
  if (args[field] !== undefined) return args[field];
  for (const alias of ALIASES[field] ?? []) {
    if (args[alias] !== undefined) return args[alias];
  }
  return undefined;
}

function placeFields(
  contract: VendorContract,
  args: Record<string, unknown>,
): { input?: Record<string, unknown>; query?: Record<string, unknown> } {
  const fields = contract.input?.fields ?? [];
  if (fields.length === 0) return { input: { ...args } };
  const input: Record<string, unknown> = {};
  const query: Record<string, unknown> = {};
  for (const field of fields) {
    const value = readArg(field.name, args);
    if (value === undefined) continue;
    if (field.in === "query") query[field.name] = value;
    else input[field.name] = value;
  }
  const placed: { input?: Record<string, unknown>; query?: Record<string, unknown> } = {};
  if (Object.keys(input).length > 0) placed.input = input;
  if (Object.keys(query).length > 0) placed.query = query;
  return placed;
}

function remainingOf(guard: SpendGuard): string {
  return formatMoney(guard.snapshot().headroomMicro);
}

function extractedSummary(tool: ToolName, extracted: unknown): string {
  if (extracted && typeof extracted === "object" && "summary" in extracted) {
    const summary = (extracted as { summary?: unknown }).summary;
    if (typeof summary === "string") return summary;
  }
  return extractFor(tool, extracted).summary;
}

async function selectVendor(
  tool: ToolName,
  args: Record<string, unknown>,
  client: PerfloClient,
  cache: ContractCache,
  headroom: Micro,
  skip: ReadonlySet<string> = new Set(),
): Promise<SelectedVendor> {
  const entry = capabilityOf(tool);
  let sawPayable = false;
  const trySlug = async (slug: string): Promise<SelectedVendor | undefined> => {
    if (skip.has(slug)) return undefined;
    try {
      const contract = await cache.get(slug);
      if (!contract.payable) return undefined;
      sawPayable = true;
      const quote = parseMoney(contract.maxChargePerCall.amount);
      if (quote <= headroom) return { status: "selected", slug, contract, quote };
    } catch {
      return undefined;
    }
    return undefined;
  };

  for (const slug of preferredVendors(tool, args)) {
    const hit = await trySlug(slug);
    if (hit) return hit;
  }

  if (entry.discoveryQuery) {
    const found = await client.search(entry.discoveryQuery);
    const ordered = [...found].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
    for (const row of ordered) {
      const hit = await trySlug(row.slug);
      if (hit) return hit;
    }
  }

  return { status: sawPayable ? "unaffordable" : "none" };
}

export function createTools(ctx: ToolContext): ResearchTools {
  const cache = new ContractCache(ctx.client);
  const limit = new Limit(ctx.concurrency ?? 4);
  let exhausted = false;

  async function cheapestAllowedQuote(): Promise<Micro | null> {
    let cheapest: Micro | null = null;
    for (const name of ctx.allowedTools) {
      if (name === "finish") continue;
      const pick = await selectVendor(name, {}, ctx.client, cache, 1n << 60n);
      if (pick.status !== "selected") continue;
      if (cheapest === null || pick.quote < cheapest) cheapest = pick.quote;
    }
    return cheapest;
  }

  async function markGlobalIfTight(headroom: Micro): Promise<void> {
    const cheapest = await cheapestAllowedQuote();
    if (cheapest === null || headroom < cheapest) exhausted = true;
  }

  const invoke = async (name: Exclude<ToolName, "finish">, args: Record<string, unknown>): Promise<ToolOutcome> => {
    if (!ctx.allowedTools.includes(name)) {
      return { outcome: "unavailable", reason: `${name} is not allowed by the tier` };
    }
    if (exhausted) return { outcome: "budget_exhausted", remaining: remainingOf(ctx.guard) };

    const canonical = canonicalizeArgs(args);
    const cached = ctx.store.findDuplicate(name, canonical);
    if (cached) {
      return {
        outcome: "ok",
        sourceId: cached.id,
        summary: extractedSummary(name, cached.extracted),
        charged: "0.000000",
        remaining: remainingOf(ctx.guard),
        cached: true,
      };
    }

    return limit.run(async () => {
      if (exhausted) return { outcome: "budget_exhausted", remaining: remainingOf(ctx.guard) };
      const skip = new Set(ctx.store.failedVendors(name, canonical));
      const selected = await selectVendor(name, args, ctx.client, cache, ctx.guard.snapshot().headroomMicro, skip);
      if (selected.status === "unaffordable") {
        const headroom = ctx.guard.snapshot().headroomMicro;
        await markGlobalIfTight(headroom);
        return { outcome: "budget_exhausted", remaining: formatMoney(headroom) };
      }
      if (selected.status === "none") {
        const reason =
          name === "screen_watchlist"
            ? "no payable watchlist vendor in the catalog"
            : "no payable vendor fits this capability";
        return { outcome: "unavailable", reason };
      }

      const reserved = ctx.guard.reserve({
        vendor: selected.slug,
        capability: name,
        amountMicro: selected.quote,
      });
      if (!reserved.ok) {
        await markGlobalIfTight(reserved.headroomMicro);
        return { outcome: "budget_exhausted", remaining: formatMoney(reserved.headroomMicro) };
      }

      const placed = placeFields(selected.contract, args);
      try {
        const paid = await ctx.client.pay(selected.slug, {
          ...placed,
          maxCharge: toMoney(selected.quote),
          idempotencyKey: reserved.idempotencyKey,
          signal: ctx.signal,
        });
        const chargedMicro = parseMoney(paid.charged.amount);
        ctx.guard.settle(reserved.id, chargedMicro, paid.transactionId, paid.status);
        const extracted = extractFor(name, paid.output);
        const failed = paid.status === "failed";
        const source = ctx.store.insert({
          ledgerId: reserved.id,
          vendor: selected.slug,
          capability: name,
          purpose: PURPOSE[name],
          status: failed ? "failed" : "succeeded",
          raw: paid.output ?? paid,
          extracted,
          dedupeKey: canonical,
        });
        if (failed) {
          return {
            outcome: "failed",
            sourceId: source.id,
            reason: paid.failure?.message ?? "vendor answered and failed",
            charged: formatMoney(chargedMicro),
            remaining: remainingOf(ctx.guard),
          };
        }
        return {
          outcome: "ok",
          sourceId: source.id,
          summary: extracted.summary,
          charged: formatMoney(chargedMicro),
          remaining: remainingOf(ctx.guard),
          cached: false,
        };
      } catch (err) {
        if (!(err instanceof PerfloError)) throw err;
        if (err.code === "SCHEMA_VALIDATION_FAILED" || err.code === "VALIDATION_ERROR") {
          cache.invalidate(selected.slug);
        }
        const action = ledgerActionForError(err);
        if (action === "hold") ctx.guard.hold(reserved.id, err.code);
        else if (action === "settle_at_reserved") ctx.guard.settle(reserved.id, selected.quote, null, err.code);
        else ctx.guard.release(reserved.id, err.code);
        const chargedMicro = action === "settle_at_reserved" ? selected.quote : 0n;
        const source = ctx.store.insert({
          ledgerId: reserved.id,
          vendor: selected.slug,
          capability: name,
          purpose: PURPOSE[name],
          status: "failed",
          raw: { code: err.code, message: err.message },
          extracted: { facts: {}, summary: err.message },
          dedupeKey: canonical,
        });
        return {
          outcome: "failed",
          sourceId: source.id,
          reason: err.message,
          charged: formatMoney(chargedMicro),
          remaining: remainingOf(ctx.guard),
        };
      }
    });
  };

  const define = (name: Exclude<ToolName, "finish">, inputSchema: z.ZodType): ExecutableTool => ({
    description: capabilityOf(name).description,
    inputSchema,
    async execute(args) {
      const parsed = inputSchema.parse(args);
      return invoke(name, parsed as Record<string, unknown>);
    },
  });

  const all: ResearchTools = {
    find_people: define("find_people", FindPeopleArgs),
    get_professional_profile: define("get_professional_profile", ProfessionalArgs),
    search_news: define("search_news", QueryArgs),
    screen_watchlist: define("screen_watchlist", WatchlistArgs),
    enrich_person: define("enrich_person", EnrichArgs),
    get_social_profile: define("get_social_profile", SocialArgs),
    search_web: define("search_web", QueryArgs),
    skip_trace: define("skip_trace", SkipTraceArgs),
    search_filings: define("search_filings", FilingsArgs),
    fetch_page: define("fetch_page", FetchPageArgs),
    finish: {
      description: capabilityOf("finish").description,
      inputSchema: FinishArgs,
      async execute() {
        if (!ctx.allowedTools.includes("finish")) {
          return { outcome: "unavailable", reason: "finish is not allowed by the tier" };
        }
        return {
          outcome: "ok",
          sourceId: "",
          summary: "Research loop finished.",
          charged: "0.000000",
          remaining: remainingOf(ctx.guard),
          cached: false,
        };
      },
    },
  };

  const out: ResearchTools = {};
  for (const name of ctx.allowedTools) {
    const row = all[name];
    if (row) out[name] = row;
  }
  return out;
}

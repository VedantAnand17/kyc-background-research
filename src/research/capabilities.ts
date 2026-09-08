// Capability map: tool -> ordered vendor preference. PRD.md section 9, ADR-0003.
// The LLM never sees these slugs. The live contract from GET /v1/vendors/{slug} is authoritative and is
// cached for one hour in tools.ts; src/research/requests.ts owns each vendor's request body.
// Verified against the funded catalog on 2026-09-08 (M7): the earlier design-time picks were unusable -
// Minerva Resolve needs an email or phone, FullEnrich has no name filter, ottoai takes a two-word topic,
// PDL's real price ($0.28) exceeds its listed cap ($0.20), and dev-fusion is blocked on the vendor side.

export type Tier = "basic" | "standard" | "deep";

export type ToolName =
  | "find_people"
  | "get_professional_profile"
  | "search_news"
  | "screen_watchlist"
  | "enrich_person"
  | "get_social_profile"
  | "search_web"
  | "skip_trace"
  | "search_filings"
  | "fetch_page"
  | "finish";

export interface CapabilityEntry {
  readonly tool: ToolName;
  readonly tier: Tier;
  /** Static preference order. Empty when the vendor is discovered at run time via POST /v1/search. */
  readonly vendors: readonly string[];
  /** Plain-English query for POST /v1/search when `vendors` is empty or every static vendor is unpayable. */
  readonly discoveryQuery?: string;
  /** Catalog capabilities a discovered vendor must carry; search ranks by text, so an unrelated hit is otherwise bought. */
  readonly discoveryCapabilities?: readonly string[];
  readonly description: string;
}

export const TIER_ORDER: readonly Tier[] = ["basic", "standard", "deep"];

export const CAPABILITIES: readonly CapabilityEntry[] = [
  {
    tool: "find_people",
    tier: "basic",
    vendors: ["stableenrich-exa-search", "stableenrich-exa-search-tempo"],
    description:
      "Find candidate identities for a full name and optional location hint. Each candidate comes with a headline, location, and LinkedIn profile URL to pass to the profile tools.",
  },
  {
    tool: "get_professional_profile",
    tier: "basic",
    vendors: ["apify-apimaestro-linkedin-profile-detail", "apify-harvestapi-linkedin-profile-scraper"],
    description: "Employment history, education, headline, and location for one LinkedIn profile URL from find_people.",
  },
  {
    tool: "search_news",
    tier: "basic",
    vendors: ["stableenrich-serper-news", "stableenrich-serper-news-tempo"],
    description: "News headlines, outlets, dates, and snippets for a query.",
  },
  {
    tool: "screen_watchlist",
    tier: "basic",
    vendors: [],
    discoveryQuery: "PEP sanctions watchlist screening",
    discoveryCapabilities: ["compliance", "screening", "sanctions", "watchlist", "kyc"],
    description: "PEP and sanctions screening. Reports not_screened when no payable vendor exists (ADR-0005).",
  },
  {
    tool: "enrich_person",
    tier: "standard",
    vendors: ["apify-anchor-linkedin-profile-enrichment", "apify-apimaestro-linkedin-profile-detail"],
    description: "Consolidated contacts, education, employers, and location for one LinkedIn profile URL.",
  },
  {
    tool: "get_social_profile",
    tier: "standard",
    vendors: ["stablesocial-twitter-profile", "stablesocial-instagram-profile"],
    description: "Public profile bio, follower count, and location on X or Instagram for a handle.",
  },
  {
    tool: "search_web",
    tier: "standard",
    vendors: ["stableenrich-exa-search", "parallel-search-mpp"],
    discoveryQuery: "web search",
    discoveryCapabilities: ["web_search"],
    description: "Ranked web pages with excerpts for a query.",
  },
  {
    tool: "skip_trace",
    tier: "deep",
    vendors: ["apify-one-api-skip-trace"],
    description: "Addresses and phones tied to an identity; the strongest DOB and place discriminator.",
  },
  {
    tool: "search_filings",
    tier: "deep",
    vendors: ["paysponge-edgar-search"],
    description: "SEC EDGAR filings naming the person.",
  },
  {
    tool: "fetch_page",
    tier: "deep",
    vendors: ["stableenrich-firecrawl-scrape"],
    description: "Full text of one URL surfaced by news or web search.",
  },
  {
    tool: "finish",
    tier: "basic",
    vendors: [],
    description: "End the research loop and move to the report.",
  },
];

export function toolsForTier(tier: Tier): readonly CapabilityEntry[] {
  const rank = TIER_ORDER.indexOf(tier);
  return CAPABILITIES.filter((c) => TIER_ORDER.indexOf(c.tier) <= rank);
}

export function capabilityOf(tool: ToolName): CapabilityEntry {
  const row = CAPABILITIES.find((c) => c.tool === tool);
  if (!row) throw new Error(`unknown tool: ${tool}`);
  return row;
}

/** Preference order, narrowed by social network when the tool is get_social_profile. */
export function preferredVendors(tool: ToolName, args: Record<string, unknown>): readonly string[] {
  const entry = capabilityOf(tool);
  if (tool !== "get_social_profile") return entry.vendors;
  const network = args.network;
  if (network === "x") return entry.vendors.filter((slug) => slug.includes("twitter"));
  if (network === "instagram") return entry.vendors.filter((slug) => slug.includes("instagram"));
  return entry.vendors;
}

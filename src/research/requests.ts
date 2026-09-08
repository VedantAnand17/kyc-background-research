// Per-vendor request bodies for the live Perflo catalog. PRD.md section 9, ADR-0003.
// The tool arguments are the model-facing shape; each vendor wants its own field names and nesting,
// verified against GET /v1/vendors/{slug} on 2026-09-08. A vendor without an adapter falls back to the
// generic field mapper in tools.ts.

type Args = Record<string, unknown>;
export type Placed = { input?: Record<string, unknown>; query?: Record<string, unknown> };
type Adapter = (args: Args) => Placed | undefined;

function str(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** `linkedin.com/in/<slug>` -> `<slug>`; anything else is returned as-is for the vendor to judge. */
export function linkedinUsername(profileUrl: string): string {
  const match = /linkedin\.com\/in\/([^/?#]+)/i.exec(profileUrl);
  return match?.[1] ? decodeURIComponent(match[1]) : profileUrl;
}

function handleOf(args: Args): string | undefined {
  const raw = str(args, "handleOrName");
  if (!raw) return undefined;
  const fromUrl = /(?:x\.com|twitter\.com|instagram\.com)\/([^/?#]+)/i.exec(raw)?.[1];
  return (fromUrl ?? raw).replace(/^@/, "");
}

/** Body for one LinkedIn-URL vendor; `undefined` when the model gave a name but no URL. */
function linkedinTarget(args: Args, build: (url: string) => Record<string, unknown>): Placed | undefined {
  const url = str(args, "profileUrl");
  return url ? { input: build(url) } : undefined;
}

/** Exa's `linkedin profile` category returns same-name profiles with headline and location: the candidate finder. */
const exaPeople: Adapter = (args) => {
  const name = str(args, "fullName");
  if (!name) return undefined;
  return {
    input: {
      query: [name, str(args, "locationHint")].filter(Boolean).join(" "),
      category: "linkedin profile",
      numResults: 8,
      contents: { text: { maxCharacters: 400 } },
    },
  };
};

const exa: Adapter = (args) => (str(args, "fullName") ? exaPeople(args) : webQuery(args));

const ADAPTERS: Record<string, Adapter> = {
  // find_people and search_web share Exa; the presence of fullName selects the people form.
  "stableenrich-exa-search": exa,
  "stableenrich-exa-search-tempo": exa,

  // get_professional_profile: both LinkedIn vendors need the URL, never a name.
  "apify-apimaestro-linkedin-profile-detail": (args) =>
    linkedinTarget(args, (url) => ({ username: linkedinUsername(url), includeEmail: true })),
  "apify-harvestapi-linkedin-profile-scraper": (args) =>
    linkedinTarget(args, (url) => ({ profileScraperMode: "Profile details no email ($4 per 1k)", urls: [url] })),

  // search_news
  "stableenrich-serper-news": serperNews,
  "stableenrich-serper-news-tempo": serperNews,

  // enrich_person: Apify request-list shape, `[{url}]`, not bare strings.
  "apify-anchor-linkedin-profile-enrichment": (args) => linkedinTarget(args, (url) => ({ startUrls: [{ url }] })),

  // get_social_profile
  "stablesocial-twitter-profile": (args) => {
    const handle = handleOf(args);
    return handle ? { input: { handle } } : undefined;
  },
  "stablesocial-instagram-profile": (args) => {
    const handle = handleOf(args);
    return handle ? { input: { handle, trim: true } } : undefined;
  },

  // search_web
  "parallel-search-mpp": (args) => {
    const q = str(args, "query");
    return q ? { input: { query: q, mode: "fast" } } : undefined;
  },

  // skip_trace: ONE API takes "Name;City, ST" strings and scrapes max_results persons per query.
  "apify-one-api-skip-trace": (args) => {
    const name = str(args, "fullName");
    if (!name) return undefined;
    const place = [str(args, "city"), str(args, "region")].filter(Boolean).join(", ");
    return { input: { name: [place ? `${name};${place}` : name], max_results: 3 } };
  },

  // search_filings
  "paysponge-edgar-search": (args) => {
    const q = str(args, "fullName") ?? str(args, "query");
    return q ? { input: { q: `"${q}"`, hits: 10 } } : undefined;
  },
};

function webQuery(args: Args): Placed | undefined {
  const q = str(args, "query");
  return q ? { input: { query: q, numResults: 8, contents: { text: { maxCharacters: 400 } } } } : undefined;
}

function serperNews(args: Args): Placed | undefined {
  const q = str(args, "query");
  return q ? { input: { q, num: 10, hl: "en" } } : undefined;
}

/** Vendor body for `slug`, `undefined` when the arguments cannot satisfy this vendor, `null` when no adapter exists. */
export function vendorRequest(slug: string, args: Args): Placed | undefined | null {
  const adapter = ADAPTERS[slug];
  if (!adapter) return null;
  return adapter(args);
}

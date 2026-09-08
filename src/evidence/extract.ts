// One extractor per capability: raw vendor payload -> typed facts + a <=1500 char summary for the model.
// PRD.md sections 6.4 and 9. Raw payloads never reach the model; this is where that rule is enforced.
import type { ToolName } from "../research/capabilities.js";

export const SUMMARY_MAX_CHARS = 1_500;

export interface Extraction {
  readonly facts: unknown;
  readonly candidateEvidence?: unknown;
  readonly summary: string;
}

type Extractor = (raw: unknown) => Extraction;

function clip(text: string): string {
  return text.length <= SUMMARY_MAX_CHARS ? text : text.slice(0, SUMMARY_MAX_CHARS);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function list(raw: Record<string, unknown>, keys: readonly string[]): unknown[] {
  for (const key of keys) {
    const value = raw[key];
    if (Array.isArray(value) && value.length > 0) return value;
  }
  return [];
}

function textOf(item: unknown, keys: readonly string[]): string | undefined {
  const rec = asRecord(item);
  if (!rec) return typeof item === "string" && item.trim() ? item.trim() : undefined;
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function joinLines(parts: Array<string | undefined>): string {
  return clip(parts.filter((part): part is string => Boolean(part)).join("\n"));
}

function fallback(raw: unknown): Extraction {
  const summary = clip(typeof raw === "string" ? raw : JSON.stringify(raw) ?? "empty");
  return { facts: raw ?? {}, summary: summary || "empty" };
}

function personItems(raw: Record<string, unknown>): unknown[] {
  return list(raw, ["people", "candidates", "results", "data", "matches"]);
}

function splitLocation(location?: string): { city?: string; country?: string } {
  if (!location) return {};
  const parts = location
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const city = parts[0];
  if (!city) return {};
  if (parts.length === 1) return { city };
  const last = parts[parts.length - 1]!;
  if (last.length === 2) return { city, country: last.toUpperCase() };
  return { city };
}

function findPeople(raw: unknown): Extraction {
  const rec = asRecord(raw) ?? {};
  const people = personItems(rec).map((item) => {
    const name = textOf(item, ["name", "fullName", "full_name"]) ?? "unknown";
    const dateOfBirth = textOf(item, ["dateOfBirth", "dob", "birth_date"]);
    const city = textOf(item, ["city"]);
    const country = textOf(item, ["country"]);
    const location = textOf(item, ["location"]);
    const company = textOf(item, ["company", "employer", "org"]);
    const profileUrl = textOf(item, ["profileUrl", "profile_url", "linkedinUrl", "url"]);
    const split = !city && location ? splitLocation(location) : {};
    const resolvedCity = city ?? split.city;
    const resolvedCountry = country ?? split.country;
    return {
      name,
      ...(dateOfBirth ? { dateOfBirth } : {}),
      ...(resolvedCity ? { city: resolvedCity } : {}),
      ...(resolvedCountry ? { country: resolvedCountry.toUpperCase() } : {}),
      ...(location ? { location } : {}),
      ...(company ? { company } : {}),
      ...(profileUrl ? { profileUrl } : {}),
    };
  });
  return {
    facts: { people },
    candidateEvidence: people,
    summary:
      joinLines(
        people.map((p) => {
          const place = p.location ?? [p.city, p.country].filter(Boolean).join(", ");
          return place ? `${p.name} (${place})` : p.name;
        }),
      ) || "no people",
  };
}

function professional(raw: unknown): Extraction {
  const rec = asRecord(raw) ?? {};
  const headline = textOf(rec, ["headline", "title"]);
  const company = textOf(rec, ["company", "org"]);
  return {
    facts: rec,
    summary: joinLines([headline, company, textOf(rec, ["location"])]) || fallback(raw).summary,
  };
}

function news(raw: unknown): Extraction {
  const rec = asRecord(raw) ?? {};
  const articles = list(rec, ["articles", "news", "results", "items"]).map((item) => ({
    title: textOf(item, ["title", "headline", "name"]) ?? "untitled",
    outlet: textOf(item, ["outlet", "source", "publisher"]),
  }));
  return {
    facts: { articles },
    summary: joinLines(articles.map((a) => (a.outlet ? `${a.title} - ${a.outlet}` : a.title))) || "no articles",
  };
}

function watchlist(raw: unknown): Extraction {
  const rec = asRecord(raw) ?? {};
  const hits = list(rec, ["hits", "matches", "results"]);
  return {
    facts: { hits, pep: rec.pep, sanctions: rec.sanctions },
    summary: hits.length === 0 ? "watchlist clear or empty" : clip(`watchlist hits: ${hits.length}`),
  };
}

function enrich(raw: unknown): Extraction {
  const rec = asRecord(raw) ?? {};
  const emails = list(rec, ["emails", "email"]);
  const phones = list(rec, ["phones", "phone"]);
  return {
    facts: { emails, phones, company: rec.company ?? rec.employer },
    summary: joinLines([
      emails.length ? `emails ${emails.length}` : undefined,
      phones.length ? `phones ${phones.length}` : undefined,
      textOf(rec, ["company", "employer"]),
    ]) || fallback(raw).summary,
  };
}

function social(raw: unknown): Extraction {
  const rec = asRecord(raw) ?? {};
  const handle = textOf(rec, ["handle", "username", "screen_name"]);
  return {
    facts: rec,
    summary: joinLines([handle, textOf(rec, ["bio", "description", "name"])]) || fallback(raw).summary,
  };
}

function web(raw: unknown): Extraction {
  const rec = asRecord(raw) ?? {};
  const results = list(rec, ["results", "organic", "items"]).map((item) => ({
    title: textOf(item, ["title", "name"]) ?? "untitled",
    url: textOf(item, ["url", "link"]),
  }));
  return {
    facts: { results },
    summary: joinLines(results.map((r) => (r.url ? `${r.title} ${r.url}` : r.title))) || "no results",
  };
}

function skipTrace(raw: unknown): Extraction {
  const rec = asRecord(raw) ?? {};
  const addresses = list(rec, ["addresses", "address"]);
  const phones = list(rec, ["phones", "phone"]);
  return {
    facts: { addresses, phones },
    summary: joinLines([
      addresses.length ? `addresses ${addresses.length}` : undefined,
      phones.length ? `phones ${phones.length}` : undefined,
    ]) || fallback(raw).summary,
  };
}

function filings(raw: unknown): Extraction {
  const rec = asRecord(raw) ?? {};
  const rows = list(rec, ["filings", "results", "items"]).map(
    (item) => textOf(item, ["title", "name", "form"]) ?? "filing",
  );
  return { facts: { filings: rows }, summary: joinLines(rows) || "no filings" };
}

function page(raw: unknown): Extraction {
  const rec = asRecord(raw) ?? {};
  const text = textOf(rec, ["markdown", "content", "text", "html"]) ?? fallback(raw).summary;
  return { facts: { text: clip(text) }, summary: clip(text) };
}

const EXTRACTORS: Record<Exclude<ToolName, "finish">, Extractor> = {
  find_people: findPeople,
  get_professional_profile: professional,
  search_news: news,
  screen_watchlist: watchlist,
  enrich_person: enrich,
  get_social_profile: social,
  search_web: web,
  skip_trace: skipTrace,
  search_filings: filings,
  fetch_page: page,
};

export function extractFor(tool: string, raw: unknown): Extraction {
  const extractor = EXTRACTORS[tool as Exclude<ToolName, "finish">];
  if (!extractor) return fallback(raw);
  return extractor(raw);
}

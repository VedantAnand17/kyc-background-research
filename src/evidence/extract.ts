// One extractor per capability: raw vendor payload -> typed facts + a <=1500 char summary for the model.
// PRD.md sections 6.4 and 9. Raw payloads never reach the model; this is where that rule is enforced.
// Live payload shapes were recorded from the funded catalog on 2026-09-08 (M7); the generic key lists
// keep the recorded fixtures and the in-process fake readable too.
import type { ToolName } from "../research/capabilities.js";

export const SUMMARY_MAX_CHARS = 1_500;

export interface Extraction {
  readonly facts: unknown;
  readonly candidateEvidence?: unknown;
  readonly summary: string;
}

type Extractor = (raw: unknown) => Extraction;
type Rec = Record<string, unknown>;

function clip(text: string): string {
  return text.length <= SUMMARY_MAX_CHARS ? text : text.slice(0, SUMMARY_MAX_CHARS);
}

function asRecord(value: unknown): Rec | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Rec;
  return undefined;
}

/** Apify actors answer with a dataset array; the first item is the record for a single-target call. */
function first(raw: unknown): Rec {
  if (Array.isArray(raw)) return asRecord(raw[0]) ?? {};
  return asRecord(raw) ?? {};
}

function list(raw: Rec, keys: readonly string[]): unknown[] {
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
    if (typeof value === "number") return String(value);
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

function compact<T extends Rec>(rec: T): Partial<T> {
  const out: Rec = {};
  for (const [key, value] of Object.entries(rec)) if (value !== undefined && value !== "") out[key] = value;
  return out as Partial<T>;
}

/** "Redmond, Washington, United States (US)" -> city Redmond, country US. Bare "Lagos, NG" also works. */
export function splitLocation(location?: string): { city?: string; country?: string } {
  if (!location) return {};
  const code = /\(([A-Z]{2})\)\s*$/.exec(location)?.[1];
  const parts = location
    .replace(/\s*\([A-Z]{2}\)\s*$/, "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const city = parts[0];
  if (!city) return code ? { country: code } : {};
  const last = parts[parts.length - 1]!;
  const country = code ?? (parts.length > 1 && last.length === 2 ? last.toUpperCase() : undefined);
  return country ? { city, country } : { city };
}

function companyFromHeadline(headline?: string): string | undefined {
  const match = headline ? /\b(?:at|@)\s+([^|,·]+)/i.exec(headline) : null;
  return match?.[1]?.trim();
}

interface Person {
  readonly name: string;
  readonly dateOfBirth?: string;
  readonly city?: string;
  readonly country?: string;
  readonly location?: string;
  readonly company?: string;
  readonly headline?: string;
  readonly profileUrl?: string;
}

/** Exa `linkedin profile` result: title is the name; text is "# Name\n\nHeadline\n\nCity, Region, Country (CC)\n\n...". */
function exaProfile(item: Rec): Person | undefined {
  const url = textOf(item, ["url"]);
  if (!url || !/linkedin\.com\/in\//i.test(url)) return undefined;
  const lines = (textOf(item, ["text"]) ?? "")
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter(Boolean);
  const name = textOf(item, ["title"])?.replace(/\s+-\s+LinkedIn$/i, "").split(" - ")[0]?.trim() ?? lines[0] ?? "unknown";
  const headline = lines[1];
  const location = lines[2] && !/connections|followers/i.test(lines[2]) ? lines[2] : undefined;
  return compact({ name, headline, location, company: companyFromHeadline(headline), profileUrl: url, ...splitLocation(location) }) as Person;
}

function genericPerson(item: unknown): Person {
  const name = textOf(item, ["name", "fullName", "full_name"]) ?? "unknown";
  const location = textOf(item, ["location"]);
  const split = splitLocation(location);
  const country = textOf(item, ["country"]) ?? split.country;
  return compact({
    name,
    dateOfBirth: textOf(item, ["dateOfBirth", "dob", "birth_date"]),
    city: textOf(item, ["city"]) ?? split.city,
    country: country?.toUpperCase(),
    location,
    company: textOf(item, ["company", "employer", "org"]),
    profileUrl: textOf(item, ["profileUrl", "profile_url", "linkedinUrl", "url"]),
  }) as Person;
}

function personLine(p: Person): string {
  const place = p.location ?? [p.city, p.country].filter(Boolean).join(", ");
  const bits = [p.headline ?? p.company, place, p.dateOfBirth ? `born ${p.dateOfBirth}` : undefined].filter(Boolean);
  const url = p.profileUrl ? ` ${p.profileUrl}` : "";
  return bits.length ? `${p.name} - ${bits.join(" - ")}${url}` : `${p.name}${url}`;
}

function findPeople(raw: unknown): Extraction {
  const rec = asRecord(raw) ?? {};
  const results = list(rec, ["results"]);
  const exa = results.map((item) => exaProfile(asRecord(item) ?? {})).filter((p): p is Person => Boolean(p));
  const people = exa.length > 0 ? exa : list(rec, ["people", "candidates", "data", "matches"]).map(genericPerson);
  return { facts: { people }, candidateEvidence: people, summary: joinLines(people.map(personLine)) || "no people" };
}

interface Stint {
  readonly title?: string;
  readonly company?: string;
  readonly start?: string;
  readonly end?: string;
  readonly current?: boolean;
}

function stintOf(item: unknown): Stint {
  const rec = asRecord(item) ?? {};
  const startDate = asRecord(rec.start_date);
  const endDate = asRecord(rec.end_date);
  const start = textOf(rec, ["starts_at", "start"]) ?? (startDate ? [startDate.month, startDate.year].filter(Boolean).join(" ") : undefined);
  const end = textOf(rec, ["ends_at", "end"]) ?? (endDate ? [endDate.month, endDate.year].filter(Boolean).join(" ") : undefined);
  return compact({
    title: textOf(rec, ["title", "position"]),
    company: textOf(rec, ["company", "company_name", "organisation"]),
    start: start || undefined,
    end: end || undefined,
    current: rec.is_current === true || undefined,
  }) as Stint;
}

function schoolOf(item: unknown): string | undefined {
  const rec = asRecord(item) ?? {};
  const school = textOf(rec, ["school", "school_name", "institution"]);
  const degree = textOf(rec, ["degree_name", "degree"]);
  return school ? (degree ? `${school} (${degree})` : school) : undefined;
}

/** apimaestro (`basic_info` + `experience`), anchor (flat + `experiences`), and generic profile shapes. */
function profileFacts(raw: unknown): { facts: Rec; lines: Array<string | undefined> } {
  const rec = first(raw);
  const info = asRecord(rec.basic_info) ?? rec;
  const loc = asRecord(info.location);
  const name = textOf(info, ["fullname", "full_name", "fullName", "name"]);
  const headline = textOf(info, ["headline", "title"]);
  const experience = list(rec, ["experience", "experiences", "positions"]).map(stintOf);
  const education = list(rec, ["education", "educations"]).map(schoolOf).filter((s): s is string => Boolean(s));
  const currentStint = experience.find((s) => s.current) ?? experience[0];
  const company = textOf(info, ["current_company", "company_name", "company", "org", "employer"]) ?? currentStint?.company ?? companyFromHeadline(headline);
  const rawLocation = textOf(loc, ["full"]) ?? textOf(info, ["location"]);
  const split = splitLocation(rawLocation);
  const city = (textOf(info, ["city"]) ?? textOf(loc, ["city"]) ?? split.city)?.split(",")[0]?.trim();
  const countryCode = textOf(loc, ["country_code"]) ?? split.country;
  const country = countryCode && countryCode.length === 2 ? countryCode.toUpperCase() : undefined;
  const emails = [
    ...list(info, ["personal_emails", "emails"]),
    ...(typeof info.email === "string" && info.email ? [info.email] : []),
  ].filter((e): e is string => typeof e === "string");
  const phones = list(info, ["personal_numbers", "phones", "phone_numbers"]).filter((p): p is string => typeof p === "string");
  const facts = compact({
    name,
    headline,
    company,
    city,
    country,
    location: rawLocation ?? textOf(info, ["country"]),
    profileUrl: textOf(info, ["profile_url", "url", "linkedinUrl"]),
    experience: experience.length ? experience : undefined,
    education: education.length ? education : undefined,
    emails: emails.length ? emails : undefined,
    phones: phones.length ? phones : undefined,
    followers: typeof info.follower_count === "number" ? info.follower_count : undefined,
  });
  const lines: Array<string | undefined> = [
    [name, headline].filter(Boolean).join(" - ") || undefined,
    facts.location as string | undefined,
    experience.length
      ? `experience: ${experience
          .slice(0, 6)
          .map((s) => [s.title, s.company].filter(Boolean).join(" at ") + (s.start ? ` (${s.start}${s.end ? ` - ${s.end}` : s.current ? " - present" : ""})` : ""))
          .join("; ")}`
      : undefined,
    education.length ? `education: ${education.slice(0, 4).join("; ")}` : undefined,
    emails.length ? `emails ${emails.length}` : undefined,
    phones.length ? `phones ${phones.length}` : undefined,
  ];
  return { facts, lines };
}

function professional(raw: unknown): Extraction {
  const { facts, lines } = profileFacts(raw);
  return { facts, summary: joinLines(lines) || fallback(raw).summary };
}

function enrich(raw: unknown): Extraction {
  const rec = first(raw);
  if (rec.basic_info || rec.experiences || rec.headline || rec.full_name) return professional(raw);
  const emails = list(rec, ["emails", "email"]);
  const phones = list(rec, ["phones", "phone"]);
  return {
    facts: { emails, phones, company: rec.company ?? rec.employer },
    summary:
      joinLines([
        emails.length ? `emails ${emails.length}` : undefined,
        phones.length ? `phones ${phones.length}` : undefined,
        textOf(rec, ["company", "employer"]),
      ]) || fallback(raw).summary,
  };
}

function news(raw: unknown): Extraction {
  const rec = asRecord(raw) ?? {};
  const articles = list(rec, ["news", "articles", "results", "items"]).map((item) =>
    compact({
      title: textOf(item, ["title", "headline", "name"]) ?? "untitled",
      outlet: textOf(item, ["source", "outlet", "publisher"]),
      url: textOf(item, ["link", "url"]),
      date: textOf(item, ["date", "publishedDate", "published_at"]),
      snippet: textOf(item, ["snippet", "description", "summary"]),
    }),
  );
  return {
    facts: { articles },
    summary:
      joinLines(
        articles.map((a) => {
          const head = a.outlet ? `${a.title} - ${a.outlet}` : a.title!;
          const tail = [a.date, a.snippet].filter(Boolean).join(": ");
          return tail ? `${head} (${tail})` : head;
        }),
      ) || "no articles",
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

/** X answers with GraphQL `legacy`/`core` blocks; Instagram and the generic fake are flat. */
function social(raw: unknown): Extraction {
  const rec = asRecord(raw) ?? {};
  const legacy = asRecord(rec.legacy) ?? {};
  const core = asRecord(rec.core) ?? {};
  const handle = textOf(rec, ["handle", "username", "screen_name"]) ?? textOf(core, ["screen_name"]) ?? textOf(legacy, ["screen_name"]);
  const name = textOf(rec, ["name", "full_name"]) ?? textOf(core, ["name"]) ?? textOf(legacy, ["name"]);
  const bio = textOf(rec, ["bio", "description", "biography"]) ?? textOf(legacy, ["description"]);
  const location = textOf(rec, ["location"]) ?? textOf(asRecord(rec.location), ["location"]) ?? textOf(legacy, ["location"]);
  const followersRaw = rec.followers_count ?? rec.follower_count ?? legacy.followers_count;
  const followers = typeof followersRaw === "number" ? followersRaw : undefined;
  const verified = rec.is_blue_verified === true || rec.verified === true || legacy.verified === true || undefined;
  const facts = compact({ handle, name, bio, location, followers, verified, ...splitLocation(location) });
  return {
    facts: Object.keys(facts).length ? facts : rec,
    summary:
      joinLines([
        [handle ? `@${handle}` : undefined, name].filter(Boolean).join(" ") || undefined,
        bio,
        location,
        followers !== undefined ? `${followers} followers${verified ? ", verified" : ""}` : undefined,
      ]) || fallback(raw).summary,
  };
}

/** Exa (`results[].text`) and Parallel (`results[].excerpts[]`) plus the generic shape. */
function web(raw: unknown): Extraction {
  const rec = asRecord(raw) ?? {};
  const results = list(rec, ["results", "organic", "items"]).map((item) => {
    const excerpts = list(asRecord(item) ?? {}, ["excerpts"]).filter((e): e is string => typeof e === "string");
    return compact({
      title: textOf(item, ["title", "name"]) ?? "untitled",
      url: textOf(item, ["url", "link"]),
      snippet: (textOf(item, ["text", "snippet"]) ?? excerpts.join(" "))?.replace(/\s+/g, " ").slice(0, 240) || undefined,
      date: textOf(item, ["publishedDate", "publish_date", "date"]),
    });
  });
  return {
    facts: { results },
    summary:
      joinLines(results.map((r) => `${r.title}${r.url ? ` ${r.url}` : ""}${r.snippet ? `: ${r.snippet}` : ""}`)) || "no results",
  };
}

/** ONE API rows use spaced, capitalised keys and pad misses with "Person Not Found". */
function skipTraceRow(item: unknown): Person & { readonly age?: string; readonly addresses: string[]; readonly phones: string[] } | undefined {
  const rec = asRecord(item) ?? {};
  const firstName = textOf(rec, ["First Name", "first_name", "firstName"]);
  const lastName = textOf(rec, ["Last Name", "last_name", "lastName"]);
  const name = [firstName, lastName].filter(Boolean).join(" ") || textOf(rec, ["name"]);
  if (!name || /not found/i.test(name)) return undefined;
  const street = textOf(rec, ["Street Address"]);
  const locality = textOf(rec, ["Address Locality"]);
  const region = textOf(rec, ["Address Region"]);
  const lives = textOf(rec, ["Lives in"]);
  const phones = Object.entries(rec)
    .filter(([key, value]) => /^Phone-\d+$/.test(key) && typeof value === "string" && value.trim())
    .map(([, value]) => (value as string).trim());
  const address = [street, locality, region, textOf(rec, ["Postal Code"])].filter(Boolean).join(", ");
  const split = splitLocation(lives);
  return compact({
    name,
    age: textOf(rec, ["Age"]),
    dateOfBirth: textOf(rec, ["Born", "dob", "dateOfBirth"]),
    city: locality ?? split.city,
    country: region || split.country ? "US" : undefined,
    location: lives,
    addresses: address ? [address] : [],
    phones,
  }) as Person & { readonly age?: string; readonly addresses: string[]; readonly phones: string[] };
}

function skipTrace(raw: unknown): Extraction {
  if (Array.isArray(raw)) {
    const people = raw.map(skipTraceRow).filter((p): p is NonNullable<typeof p> => Boolean(p));
    return {
      facts: { people, addresses: people.flatMap((p) => p.addresses), phones: people.flatMap((p) => p.phones) },
      summary:
        joinLines(
          people.map(
            (p) =>
              `${p.name}${p.age ? `, age ${p.age}` : ""}${p.dateOfBirth ? `, born ${p.dateOfBirth}` : ""}${p.location ? `, lives in ${p.location}` : ""}` +
              `${p.addresses.length ? `; address ${p.addresses[0]}` : ""}${p.phones.length ? `; phones ${p.phones.length}` : ""}`,
          ),
        ) || "no matching person",
    };
  }
  const rec = asRecord(raw) ?? {};
  const addresses = list(rec, ["addresses", "address"]);
  const phones = list(rec, ["phones", "phone"]);
  return {
    facts: { addresses, phones },
    summary:
      joinLines([
        addresses.length ? `addresses ${addresses.length}` : undefined,
        phones.length ? `phones ${phones.length}` : undefined,
      ]) || fallback(raw).summary,
  };
}

/** EDGAR full-text search: `data.hits.hits[]._source` with form, file_date, display_names. */
function filings(raw: unknown): Extraction {
  const rec = asRecord(raw) ?? {};
  const edgarHits = list(asRecord(asRecord(rec.data)?.hits) ?? {}, ["hits"]);
  const rows =
    edgarHits.length > 0
      ? edgarHits.map((hit) => {
          const source = asRecord(asRecord(hit)?._source) ?? {};
          const names = list(source, ["display_names"]).filter((n): n is string => typeof n === "string");
          return compact({
            form: textOf(source, ["form", "file_type"]),
            date: textOf(source, ["file_date"]),
            names,
            title: [textOf(source, ["form"]), textOf(source, ["file_date"]), names.join("; ")].filter(Boolean).join(" "),
          });
        })
      : list(rec, ["filings", "results", "items"]).map((item) => ({ title: textOf(item, ["title", "name", "form"]) ?? "filing" }));
  return { facts: { filings: rows }, summary: joinLines(rows.map((r) => r.title)) || "no filings" };
}

/** Drop markdown images, bare link targets, and blank runs so the 1500-char window holds prose, not URLs. */
function plainText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function page(raw: unknown): Extraction {
  const rec = asRecord(raw) ?? {};
  const text = plainText(textOf(rec, ["markdown", "content", "text", "html"]) ?? fallback(raw).summary);
  const title = textOf(rec, ["title"]);
  return { facts: compact({ title, url: textOf(rec, ["url"]), text: clip(text) }), summary: clip(title ? `${title}\n${text}` : text) };
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

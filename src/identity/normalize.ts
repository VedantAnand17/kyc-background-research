// Name normalization and alias table for the Matcher. PRD.md section 8.1.
//
// normalizeName(): NFKD, strip diacritics, lowercase, drop punctuation, collapse whitespace,
// drop middle names and suffixes (Jr, Sr, II, III).
// nameSimilarity(): exact 1.0; known nickname or alias 0.9; otherwise Jaro-Winkler.
// jaroWinkler(a, b): standard implementation, no dependency.

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v", "junior", "senior", "esq", "phd", "md"]);

/** Canonical first name plus its nicknames. Comparison is bidirectional. */
export const NICKNAME_GROUPS: readonly (readonly string[])[] = [
  ["william", "bill", "will", "billy", "liam"],
  ["robert", "rob", "bob", "bobby", "robbie"],
  ["richard", "rick", "dick", "rich", "ricky"],
  ["elizabeth", "liz", "beth", "betty", "eliza", "lisa"],
  ["michael", "mike", "mick"],
  ["jennifer", "jenny", "jen"],
  ["christopher", "chris"],
  ["matthew", "matt"],
  ["andrew", "andy", "drew"],
  ["jonathan", "jon"],
  ["john", "jack", "johnny"],
  ["james", "jim", "jimmy", "jamie"],
  ["joseph", "joe", "joey"],
  ["thomas", "tom", "tommy"],
  ["charles", "chuck", "charlie"],
  ["edward", "ed", "ted", "eddie"],
  ["margaret", "maggie", "meg", "peggy"],
  ["katherine", "kate", "kathy", "cathy"],
  ["daniel", "dan", "danny"],
  ["david", "dave"],
  ["anthony", "tony"],
  ["benjamin", "ben", "benny"],
  ["alexander", "alex"],
  ["nicholas", "nick", "nicky"],
  ["samuel", "sam", "sammy"],
  ["joshua", "josh"],
  ["nathan", "nate"],
  ["timothy", "tim", "timmy"],
  ["steven", "stephen", "steve"],
  ["gregory", "greg"],
  ["patrick", "pat", "paddy"],
  ["peter", "pete"],
];

const NICKNAME_TO_GROUP: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const map = new Map<string, ReadonlySet<string>>();
  for (const group of NICKNAME_GROUPS) {
    const set = new Set(group);
    for (const name of group) map.set(name, set);
  }
  return map;
})();

export function normalizeName(raw: string): string {
  const stripped = raw
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return "";
  const tokens = stripped.split(" ").filter((t) => t && !SUFFIXES.has(t));
  if (tokens.length >= 3) return `${tokens[0]} ${tokens[tokens.length - 1]}`;
  return tokens.join(" ");
}

function aliasesOf(first: string): ReadonlySet<string> | undefined {
  return NICKNAME_TO_GROUP.get(first);
}

function areAliases(normalizedA: string, normalizedB: string): boolean {
  const a = normalizedA.split(" ");
  const b = normalizedB.split(" ");
  if (a.length < 2 || b.length < 2) return false;
  const aLast = a[a.length - 1]!;
  const bLast = b[b.length - 1]!;
  if (aLast !== bLast) return false;
  const aFirst = a[0]!;
  const bFirst = b[0]!;
  if (aFirst === bFirst) return false;
  return aliasesOf(aFirst)?.has(bFirst) === true;
}

export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (areAliases(na, nb)) return 0.9;
  return jaroWinkler(na, nb);
}

export function jaroWinkler(s1: string, s2: string): number {
  if (s1.length === 0 || s2.length === 0) return 0;
  if (s1 === s2) return 1;

  const matchDistance = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const s1Matched = new Array<boolean>(s1.length).fill(false);
  const s2Matched = new Array<boolean>(s2.length).fill(false);

  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, s2.length);
    for (let j = start; j < end; j++) {
      if (s2Matched[j] || s1[i] !== s2[j]) continue;
      s1Matched[i] = true;
      s2Matched[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matched[i]) continue;
    while (!s2Matched[k]) k += 1;
    if (s1[i] !== s2[k]) transpositions += 1;
    k += 1;
  }

  const jaro =
    (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3;

  let prefix = 0;
  const prefixBound = Math.min(4, s1.length, s2.length);
  while (prefix < prefixBound && s1[prefix] === s2[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

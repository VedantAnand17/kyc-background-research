// Name normalization and alias table for the Matcher. PRD.md section 8.1.
//
// TODO(M4): normalizeName(): NFKD, strip diacritics, lowercase, drop punctuation, collapse whitespace,
// drop middle names and suffixes (Jr, Sr, II, III). ALIASES: small nickname table (william -> bill, ...).
// jaroWinkler(a, b): standard implementation, no dependency.

export function normalizeName(_raw: string): string {
  throw new Error("TODO(M4): implement normalizeName per PRD.md section 8.1");
}

export function jaroWinkler(_a: string, _b: string): number {
  throw new Error("TODO(M4): implement jaroWinkler per PRD.md section 8.1");
}

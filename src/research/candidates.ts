// Turn stored Sources into Matcher CandidateEvidence. PRD.md sections 6.2 and 8.
import type { SourceRecord } from "../evidence/store.js";
import type { CandidateEvidence, SourcedFact } from "../identity/matcher.js";

interface PersonFact {
  readonly name?: string;
  readonly dateOfBirth?: string;
  readonly city?: string;
  readonly country?: string;
  readonly location?: string;
  readonly company?: string;
  readonly profileUrl?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function peopleOf(source: SourceRecord): PersonFact[] {
  const extracted = asRecord(source.extracted);
  const facts = asRecord(extracted?.facts) ?? extracted;
  const list = facts?.people;
  if (!Array.isArray(list)) return [];
  return list.map((item) => {
    const row = asRecord(item) ?? {};
    const name = optionalString(row.name);
    const dateOfBirth = optionalString(row.dateOfBirth);
    const city = optionalString(row.city);
    const country = optionalString(row.country);
    const location = optionalString(row.location);
    const company = optionalString(row.company);
    const profileUrl = optionalString(row.profileUrl);
    return {
      ...(name ? { name } : {}),
      ...(dateOfBirth ? { dateOfBirth } : {}),
      ...(city ? { city } : {}),
      ...(country ? { country } : {}),
      ...(location ? { location } : {}),
      ...(company ? { company } : {}),
      ...(profileUrl ? { profileUrl } : {}),
    };
  });
}

function fact(value: string | undefined, sourceId: string): SourcedFact[] {
  return value ? [{ value, sourceId }] : [];
}

function mergeCandidate(base: CandidateEvidence, extra: CandidateEvidence): CandidateEvidence {
  const dob = base.dateOfBirth ?? extra.dateOfBirth;
  const city = base.city ?? extra.city;
  const country = base.country ?? extra.country;
  return {
    id: base.id,
    names: [...new Set([...base.names, ...extra.names])],
    ...(dob ? { dateOfBirth: dob } : {}),
    ...(city ? { city } : {}),
    ...(country ? { country } : {}),
    employers: [...base.employers, ...extra.employers],
    handles: [...base.handles, ...extra.handles],
    profileUrls: [...base.profileUrls, ...extra.profileUrls],
    sourceIds: [...new Set([...base.sourceIds, ...extra.sourceIds])],
  };
}

function fromPerson(id: string, person: PersonFact, sourceId: string): CandidateEvidence {
  return {
    id,
    names: person.name ? [person.name] : [],
    ...(person.dateOfBirth ? { dateOfBirth: person.dateOfBirth } : {}),
    ...(person.city ? { city: person.city } : {}),
    ...(person.country ? { country: person.country } : {}),
    employers: fact(person.company, sourceId),
    handles: [],
    profileUrls: fact(person.profileUrl, sourceId),
    sourceIds: [sourceId],
  };
}

function fold(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function samePerson(a: CandidateEvidence, name?: string): boolean {
  if (!name) return false;
  const target = fold(name);
  return a.names.some((n) => fold(n) === target);
}

function extrasFromSource(source: SourceRecord): Partial<CandidateEvidence> & { readonly name?: string } {
  const extracted = asRecord(source.extracted);
  const facts = asRecord(extracted?.facts) ?? extracted ?? {};
  const company = optionalString(facts.company);
  const handle = optionalString(facts.handle);
  const name = optionalString(facts.name);
  const city = optionalString(facts.city);
  const country = optionalString(facts.country);
  return {
    ...(name ? { name } : {}),
    ...(city ? { city } : {}),
    ...(country ? { country } : {}),
    employers: fact(company, source.id),
    handles: fact(handle, source.id),
    sourceIds: [source.id],
  };
}

export function candidatesFromSources(sources: readonly SourceRecord[]): CandidateEvidence[] {
  const resolved: CandidateEvidence[] = [];
  let next = 1;
  for (const source of sources) {
    if (source.capability !== "find_people" || source.status !== "succeeded") continue;
    for (const person of peopleOf(source)) {
      resolved.push(fromPerson(`c${next}`, person, source.id));
      next += 1;
    }
  }

  for (const source of sources) {
    if (source.capability === "find_people" || source.status !== "succeeded") continue;
    const extra = extrasFromSource(source);
    if (resolved.length === 0) continue;
    const match = extra.name ? resolved.find((c) => samePerson(c, extra.name)) : undefined;
    const target = match ?? resolved[0]!;
    const idx = resolved.indexOf(target);
    resolved[idx] = mergeCandidate(target, {
      id: target.id,
      names: extra.name ? [extra.name] : [],
      ...(extra.city ? { city: extra.city } : {}),
      ...(extra.country ? { country: extra.country } : {}),
      employers: extra.employers ?? [],
      handles: extra.handles ?? [],
      profileUrls: [],
      sourceIds: extra.sourceIds ?? [source.id],
    });
  }
  return resolved;
}

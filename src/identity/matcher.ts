// Deterministic identity scoring. PRD.md section 8. Unit-tested against fixtures (test/matcher.test.ts).
//
// Weights: name 0.35, dob 0.25, location 0.20, corroboration 0.20.
// DOB conflict caps the total at 0.30. Location conflict subtracts 0.30.
// Missing request inputs redistribute their weight and cap the total at 0.85.
// Labels: confirmed >= 0.80, probable 0.55-0.79, possible < 0.55.
// Primary candidate: confirmed, or probable leading the runner-up by >= 0.15.

import { nameSimilarity } from "./normalize.js";

export type MatchSignal = "name" | "dob" | "location" | "corroboration";
export type CandidateLabel = "confirmed" | "probable" | "possible";
export type IdentityStatus = "confirmed" | "probable" | "ambiguous" | "not_found";

export interface SubjectInput {
  readonly fullName: string;
  readonly dateOfBirth?: string;
  readonly city?: string;
  readonly country?: string;
}

/** A fact tagged with the Source that produced it, so corroboration can count independent Sources. */
export interface SourcedFact {
  readonly value: string;
  readonly sourceId: string;
}

export interface CandidateEvidence {
  readonly id: string;
  readonly names: readonly string[];
  readonly dateOfBirth?: string;
  readonly birthYear?: number;
  readonly city?: string;
  readonly country?: string;
  readonly employers: readonly SourcedFact[];
  readonly handles: readonly SourcedFact[];
  readonly profileUrls: readonly SourcedFact[];
  readonly sourceIds: readonly string[];
}

export interface ScoredCandidate {
  readonly id: string;
  readonly confidence: number;
  readonly label: CandidateLabel;
  readonly matchedOn: readonly MatchSignal[];
  readonly conflicts: readonly MatchSignal[];
  readonly sourceIds: readonly string[];
}

export interface IdentityDecision {
  readonly status: IdentityStatus;
  readonly primaryCandidateId: string | null;
  readonly candidates: readonly ScoredCandidate[];
  readonly warnings: readonly string[];
}

const BASE_WEIGHTS: Readonly<Record<MatchSignal, number>> = {
  name: 0.35,
  dob: 0.25,
  location: 0.2,
  corroboration: 0.2,
};

const CONFIRMED_MIN = 0.8;
const PROBABLE_MIN = 0.55;
const DOB_CONFLICT_CAP = 0.3;
const LOCATION_CONFLICT_PENALTY = 0.3;
const MISSING_INPUT_CAP = 0.85;
const PRIMARY_GAP = 0.15;
const ALL_SIGNALS: readonly MatchSignal[] = ["name", "dob", "location", "corroboration"];

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function labelOf(score: number): CandidateLabel {
  if (score >= CONFIRMED_MIN) return "confirmed";
  if (score >= PROBABLE_MIN) return "probable";
  return "possible";
}

function missingLocation(subject: SubjectInput): boolean {
  return !subject.city && !subject.country;
}

function weightsFor(subject: SubjectInput): Readonly<Record<MatchSignal, number>> {
  const dropped: MatchSignal[] = [];
  if (!subject.dateOfBirth) dropped.push("dob");
  if (missingLocation(subject)) dropped.push("location");
  if (dropped.length === 0) return BASE_WEIGHTS;

  const remaining = ALL_SIGNALS.filter((s) => !dropped.includes(s));
  const remainingSum = remaining.reduce((sum, s) => sum + BASE_WEIGHTS[s], 0);
  const droppedSum = dropped.reduce((sum, s) => sum + BASE_WEIGHTS[s], 0);
  const weights: Record<MatchSignal, number> = { name: 0, dob: 0, location: 0, corroboration: 0 };
  for (const signal of remaining) {
    weights[signal] = BASE_WEIGHTS[signal] + droppedSum * (BASE_WEIGHTS[signal] / remainingSum);
  }
  return weights;
}

function yearOf(iso?: string, birthYear?: number): number | undefined {
  if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) return Number(iso.slice(0, 4));
  if (birthYear != null) return birthYear;
  return undefined;
}

function scoreName(subject: SubjectInput, candidate: CandidateEvidence): number {
  if (candidate.names.length === 0) return 0;
  return Math.max(...candidate.names.map((n) => nameSimilarity(subject.fullName, n)));
}

function scoreDob(
  subjectDob: string | undefined,
  candidate: CandidateEvidence,
): { score: number; conflict: boolean } {
  if (!subjectDob) return { score: 0, conflict: false };
  const candFull = candidate.dateOfBirth;
  const candYear = yearOf(candidate.dateOfBirth, candidate.birthYear);
  if (!candFull && candYear == null) return { score: 0, conflict: false };
  if (candFull && candFull === subjectDob) return { score: 1, conflict: false };
  if (candFull && candFull !== subjectDob) return { score: 0, conflict: true };
  const subYear = yearOf(subjectDob);
  if (candYear != null && subYear != null) {
    if (candYear === subYear) return { score: 0.6, conflict: false };
    return { score: 0, conflict: true };
  }
  return { score: 0, conflict: false };
}

function foldPlace(value?: string): string | undefined {
  if (!value) return undefined;
  const folded = value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return folded || undefined;
}

function foldCountry(value?: string): string | undefined {
  const folded = value?.trim().toUpperCase();
  return folded || undefined;
}

function scoreLocation(
  subject: SubjectInput,
  candidate: CandidateEvidence,
): { score: number; conflict: boolean } {
  if (missingLocation(subject)) return { score: 0, conflict: false };
  const sCity = foldPlace(subject.city);
  const sCountry = foldCountry(subject.country);
  const cCity = foldPlace(candidate.city);
  const cCountry = foldCountry(candidate.country);
  const cityConflict = Boolean(sCity && cCity && sCity !== cCity);
  const countryConflict = Boolean(sCountry && cCountry && sCountry !== cCountry);
  if (cityConflict || countryConflict) return { score: 0, conflict: true };
  if (sCity && cCity && sCity === cCity && sCountry && cCountry && sCountry === cCountry) {
    return { score: 1, conflict: false };
  }
  if (sCountry && cCountry && sCountry === cCountry) return { score: 0.5, conflict: false };
  if (sCity && cCity && sCity === cCity) return { score: 1, conflict: false };
  return { score: 0, conflict: false };
}

function foldFact(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function scoreCorroboration(candidate: CandidateEvidence): number {
  for (const facts of [candidate.employers, candidate.handles, candidate.profileUrls]) {
    const byValue = new Map<string, Set<string>>();
    for (const fact of facts) {
      const key = foldFact(fact.value);
      if (!key) continue;
      const sources = byValue.get(key) ?? new Set<string>();
      sources.add(fact.sourceId);
      byValue.set(key, sources);
    }
    for (const sources of byValue.values()) {
      if (sources.size >= 2) return 1;
    }
  }
  return 0;
}

function missingInputWarnings(subject?: SubjectInput): string[] {
  if (!subject) return [];
  const warnings: string[] = [];
  if (!subject.dateOfBirth) {
    warnings.push(
      "Identity rests on name, location, and corroboration because date of birth was not supplied.",
    );
  }
  if (missingLocation(subject)) {
    warnings.push(
      "Identity rests on name, date of birth, and corroboration because address was not supplied.",
    );
  }
  return warnings;
}

export function scoreCandidates(
  subject: SubjectInput,
  candidates: readonly CandidateEvidence[],
): readonly ScoredCandidate[] {
  const weights = weightsFor(subject);
  const capMissing = !subject.dateOfBirth || missingLocation(subject);

  return candidates.map((candidate) => {
    const name = scoreName(subject, candidate);
    const dob = scoreDob(subject.dateOfBirth, candidate);
    const location = scoreLocation(subject, candidate);
    const corroboration = scoreCorroboration(candidate);

    let total =
      weights.name * name +
      weights.dob * dob.score +
      weights.location * location.score +
      weights.corroboration * corroboration;
    if (location.conflict) total -= LOCATION_CONFLICT_PENALTY;
    if (total < 0) total = 0;
    if (dob.conflict) total = Math.min(total, DOB_CONFLICT_CAP);
    if (capMissing) total = Math.min(total, MISSING_INPUT_CAP);
    total = Math.min(1, round4(total));

    const matchedOn: MatchSignal[] = [];
    if (name > 0) matchedOn.push("name");
    if (dob.score > 0) matchedOn.push("dob");
    if (location.score > 0) matchedOn.push("location");
    if (corroboration > 0) matchedOn.push("corroboration");

    const conflicts: MatchSignal[] = [];
    if (dob.conflict) conflicts.push("dob");
    if (location.conflict) conflicts.push("location");

    return {
      id: candidate.id,
      confidence: total,
      label: labelOf(total),
      matchedOn,
      conflicts,
      sourceIds: candidate.sourceIds,
    };
  });
}

export function selectPrimary(
  scored: readonly ScoredCandidate[],
  subject?: SubjectInput,
): IdentityDecision {
  const warnings = missingInputWarnings(subject);
  const candidates = [...scored].sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
  if (candidates.length === 0) {
    return { status: "not_found", primaryCandidateId: null, candidates, warnings };
  }
  const top = candidates[0]!;
  const runner = candidates[1];
  if (top.label === "confirmed") {
    return { status: "confirmed", primaryCandidateId: top.id, candidates, warnings };
  }
  if (top.label === "probable" && (runner == null || top.confidence - runner.confidence >= PRIMARY_GAP)) {
    return { status: "probable", primaryCandidateId: top.id, candidates, warnings };
  }
  return { status: "ambiguous", primaryCandidateId: null, candidates, warnings };
}

export function decideIdentity(
  subject: SubjectInput,
  candidates: readonly CandidateEvidence[],
): IdentityDecision {
  return selectPrimary(scoreCandidates(subject, candidates), subject);
}

// Deterministic identity scoring. PRD.md section 8. Unit-tested against fixtures (test/matcher.test.ts).
//
// Weights: name 0.35, dob 0.25, location 0.20, corroboration 0.20.
// DOB conflict caps the total at 0.30. Location conflict subtracts 0.30.
// Missing request inputs redistribute their weight and cap the total at 0.85.
// Labels: confirmed >= 0.80, probable 0.55-0.79, possible < 0.55.
// Primary candidate: confirmed, or probable leading the runner-up by >= 0.15.
//
// TODO(M4): implement scoreCandidates() and selectPrimary().

export type MatchSignal = "name" | "dob" | "location" | "corroboration";
export type CandidateLabel = "confirmed" | "probable" | "possible";
export type IdentityStatus = "confirmed" | "probable" | "ambiguous" | "not_found";

export interface SubjectInput {
  readonly fullName: string;
  readonly dateOfBirth?: string;
  readonly city?: string;
  readonly country?: string;
}

export interface CandidateEvidence {
  readonly id: string;
  readonly names: readonly string[];
  readonly dateOfBirth?: string;
  readonly birthYear?: number;
  readonly city?: string;
  readonly country?: string;
  readonly employers: readonly string[];
  readonly handles: readonly string[];
  readonly profileUrls: readonly string[];
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

export function scoreCandidates(_subject: SubjectInput, _candidates: readonly CandidateEvidence[]): readonly ScoredCandidate[] {
  throw new Error("TODO(M4): implement scoreCandidates per PRD.md section 8");
}

export function selectPrimary(_scored: readonly ScoredCandidate[]): IdentityDecision {
  throw new Error("TODO(M4): implement selectPrimary per PRD.md section 8.3 and 6.3");
}

// Source persistence. PRD.md section 12 (`sources` table). Every fact in a report cites Source ids.
//
// TODO(M3): implement createEvidenceStore(db, jobId) with insert(source), byId(id), forJob(), forCandidate(id),
// and findDuplicate(tool, canonicalArgs) for the tool layer's dedupe.

export interface SourceRecord {
  readonly id: string;
  readonly jobId: string;
  readonly ledgerId: string | null;
  readonly vendor: string;
  readonly capability: string;
  readonly purpose: string;
  readonly candidateId: string | null;
  readonly status: "succeeded" | "failed";
  readonly raw: unknown;
  readonly extracted: unknown;
  readonly retrievedAt: string;
}

export function createEvidenceStore(): never {
  throw new Error("TODO(M3): implement createEvidenceStore per PRD.md section 12");
}

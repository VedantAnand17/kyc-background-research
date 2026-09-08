// Source persistence. PRD.md section 12 (`sources` table). Every fact in a report cites Source ids.
import { randomUUID } from "node:crypto";
import type { Db } from "../db/sqlite.js";

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

export interface NewSource {
  readonly ledgerId?: string | null;
  readonly vendor: string;
  readonly capability: string;
  readonly purpose: string;
  readonly candidateId?: string | null;
  readonly status: "succeeded" | "failed";
  readonly raw: unknown;
  readonly extracted: unknown;
  readonly dedupeKey?: string;
}

export interface EvidenceStore {
  insert(input: NewSource): SourceRecord;
  byId(id: string): SourceRecord | undefined;
  forJob(): SourceRecord[];
  forCandidate(id: string): SourceRecord[];
  findDuplicate(tool: string, canonicalArgs: string): SourceRecord | undefined;
}

interface StoredExtracted {
  readonly payload: unknown;
  readonly dedupeKey?: string;
}

interface SourceRow {
  readonly id: string;
  readonly job_id: string;
  readonly ledger_id: string | null;
  readonly vendor: string;
  readonly capability: string;
  readonly purpose: string;
  readonly candidate_id: string | null;
  readonly status: "succeeded" | "failed";
  readonly raw_json: string;
  readonly extracted_json: string;
  readonly retrieved_at: string;
}

function wrapExtracted(extracted: unknown, dedupeKey: string | undefined): StoredExtracted {
  return dedupeKey === undefined ? { payload: extracted } : { payload: extracted, dedupeKey };
}

function readExtracted(raw: string): StoredExtracted {
  const parsed: unknown = JSON.parse(raw);
  if (parsed && typeof parsed === "object" && "payload" in parsed) return parsed as StoredExtracted;
  return { payload: parsed };
}

function toRecord(row: SourceRow): SourceRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    ledgerId: row.ledger_id,
    vendor: row.vendor,
    capability: row.capability,
    purpose: row.purpose,
    candidateId: row.candidate_id,
    status: row.status,
    raw: JSON.parse(row.raw_json) as unknown,
    extracted: readExtracted(row.extracted_json).payload,
    retrievedAt: row.retrieved_at,
  };
}

export function createEvidenceStore(db: Db, jobId: string): EvidenceStore {
  const insertRow = db.prepare(`
    INSERT INTO sources (
      id, job_id, ledger_id, vendor, capability, purpose, candidate_id,
      status, raw_json, extracted_json, retrieved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectById = db.prepare(`SELECT * FROM sources WHERE id = ? AND job_id = ?`);
  const selectJob = db.prepare(`SELECT * FROM sources WHERE job_id = ? ORDER BY retrieved_at, id`);
  const selectCandidate = db.prepare(
    `SELECT * FROM sources WHERE job_id = ? AND candidate_id = ? ORDER BY retrieved_at, id`,
  );

  return {
    insert(input) {
      const id = randomUUID();
      const retrievedAt = new Date().toISOString();
      insertRow.run(
        id,
        jobId,
        input.ledgerId ?? null,
        input.vendor,
        input.capability,
        input.purpose,
        input.candidateId ?? null,
        input.status,
        JSON.stringify(input.raw),
        JSON.stringify(wrapExtracted(input.extracted, input.dedupeKey)),
        retrievedAt,
      );
      return {
        id,
        jobId,
        ledgerId: input.ledgerId ?? null,
        vendor: input.vendor,
        capability: input.capability,
        purpose: input.purpose,
        candidateId: input.candidateId ?? null,
        status: input.status,
        raw: input.raw,
        extracted: input.extracted,
        retrievedAt,
      };
    },
    byId(id) {
      const row = selectById.get(id, jobId) as SourceRow | undefined;
      return row ? toRecord(row) : undefined;
    },
    forJob() {
      return (selectJob.all(jobId) as SourceRow[]).map(toRecord);
    },
    forCandidate(id) {
      return (selectCandidate.all(jobId, id) as SourceRow[]).map(toRecord);
    },
    findDuplicate(tool, canonicalArgs) {
      // ponytail: O(n) scan of one job's sources; add a dedupe_key column if jobs grow large.
      for (const row of selectJob.all(jobId) as SourceRow[]) {
        if (row.capability !== tool) continue;
        if (readExtracted(row.extracted_json).dedupeKey === canonicalArgs) return toRecord(row);
      }
      return undefined;
    },
  };
}

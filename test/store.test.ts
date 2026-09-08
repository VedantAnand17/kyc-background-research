import { afterEach, describe, expect, it } from "vitest";
import { createEvidenceStore } from "../src/evidence/store.js";
import { openDatabase, type Db } from "../src/db/sqlite.js";

const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs) db.close();
  dbs.length = 0;
});

function tracked(jobId = "job-1"): Db {
  const db = openDatabase(":memory:");
  db.prepare(
    `INSERT INTO jobs (id, created_at, tier, cap_micro, spent_micro, status, request_json)
     VALUES (?, ?, 'standard', '1500000', '0', 'running', '{}')`,
  ).run(jobId, new Date().toISOString());
  dbs.push(db);
  return db;
}

function sample(over: Partial<Parameters<ReturnType<typeof createEvidenceStore>["insert"]>[0]> = {}) {
  return {
    vendor: "stableenrich-minerva-resolve",
    capability: "find_people",
    purpose: "resolve candidates",
    status: "succeeded" as const,
    raw: { people: [{ name: "Ada Okonkwo" }] },
    extracted: { facts: { names: ["Ada Okonkwo"] }, summary: "Ada Okonkwo" },
    dedupeKey: '{"fullName":"Ada Okonkwo"}',
    ...over,
  };
}

describe("evidence store", () => {
  it("inserts a source and finds it by id, job, and candidate", () => {
    const store = createEvidenceStore(tracked(), "job-1");
    const row = store.insert({ ...sample(), candidateId: "c1" });
    expect(row.id).toMatch(/\w/);
    expect(row.jobId).toBe("job-1");
    expect(store.byId(row.id)).toEqual(row);
    expect(store.forJob()).toEqual([row]);
    expect(store.forCandidate("c1")).toEqual([row]);
    expect(store.forCandidate("missing")).toEqual([]);
  });

  it("findDuplicate matches capability plus canonical args", () => {
    const store = createEvidenceStore(tracked(), "job-1");
    const first = store.insert(sample());
    expect(store.findDuplicate("find_people", '{"fullName":"Ada Okonkwo"}')?.id).toBe(first.id);
    expect(store.findDuplicate("find_people", '{"fullName":"Other"}')).toBeUndefined();
    expect(store.findDuplicate("search_news", '{"fullName":"Ada Okonkwo"}')).toBeUndefined();
  });

  it("findDuplicate ignores failed sources so a retry can pay again", () => {
    const store = createEvidenceStore(tracked(), "job-1");
    store.insert(sample({ status: "failed", extracted: { facts: {}, summary: "upstream" } }));
    expect(store.findDuplicate("find_people", '{"fullName":"Ada Okonkwo"}')).toBeUndefined();
    const ok = store.insert(sample());
    expect(store.findDuplicate("find_people", '{"fullName":"Ada Okonkwo"}')?.id).toBe(ok.id);
  });
});

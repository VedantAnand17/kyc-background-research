import { randomInt } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createSpendGuard } from "../src/budget/ledger.js";
import { openDatabase, type Db } from "../src/db/sqlite.js";

const CAP = 1_000_000n;

function openJob(jobId = "job-1", capMicro = CAP): Db {
  const db = openDatabase(":memory:");
  db.prepare(
    `INSERT INTO jobs (id, created_at, tier, cap_micro, spent_micro, status, request_json)
     VALUES (?, ?, 'standard', ?, '0', 'running', '{}')`,
  ).run(jobId, new Date().toISOString(), capMicro.toString());
  return db;
}

function guard(db: Db, jobId = "job-1", capMicro = CAP, reserveMicro = 0n) {
  return createSpendGuard({ db, jobId, capMicro, reserveMicro });
}

function reserve(g: ReturnType<typeof createSpendGuard>, amountMicro: bigint, vendor = "demo-vendor") {
  return g.reserve({ vendor, capability: "web_search", amountMicro });
}

const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs) db.close();
  dbs.length = 0;
});

function tracked(): Db {
  const db = openJob();
  dbs.push(db);
  return db;
}

describe("spend guard", () => {
  it("denies a reservation when cap - spent - reserved < amount", () => {
    const db = tracked();
    const g = guard(db);
    expect(reserve(g, 600_000n).ok).toBe(true);
    const denied = reserve(g, 500_000n);
    expect(denied).toEqual({ ok: false, reason: "budget_exhausted", headroomMicro: 400_000n });
    expect(g.snapshot()).toMatchObject({ reservedMicro: 600_000n, spentMicro: 0n, headroomMicro: 400_000n });
  });

  it("N concurrent reservations of random amounts never exceed the cap (property test)", async () => {
    for (let trial = 0; trial < 40; trial++) {
      const cap = BigInt(randomInt(200_000, 5_000_000));
      const db = openJob(`job-${trial}`, cap);
      dbs.push(db);
      const g = guard(db, `job-${trial}`, cap);
      const amounts = Array.from({ length: 24 }, () => BigInt(randomInt(1, 800_000)));
      // reserve() is one synchronous SQLite transaction, so overlapping awaits still serialize
      // on the check-and-update. The property is the arithmetic: accepted reservations never
      // breach the cap, even when many race at the same tick.
      const results = await Promise.all(amounts.map((amount) => Promise.resolve(reserve(g, amount))));
      const acceptedTotal = results.reduce((sum, r, i) => (r.ok ? sum + amounts[i]! : sum), 0n);
      const snap = g.snapshot();
      expect(snap.spentMicro + snap.reservedMicro).toBeLessThanOrEqual(cap);
      expect(snap.reservedMicro).toBe(acceptedTotal);
      expect(snap.headroomMicro).toBe(cap - snap.reservedMicro - snap.spentMicro);
    }
  });

  it("settle moves reserved to spent at the charged amount, including status failed", () => {
    const db = tracked();
    const g = guard(db);
    const a = reserve(g, 25200n);
    const b = reserve(g, 40000n);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error("expected reservations");
    g.settle(a.id, 25200n, "tx-failed");
    g.settle(b.id, 18000n, "tx-ok");
    expect(g.snapshot()).toEqual({
      capMicro: CAP,
      reservedMicro: 0n,
      spentMicro: 43200n,
      headroomMicro: CAP - 43200n,
    });
  });

  it("release returns the reservation to headroom", () => {
    const db = tracked();
    const g = guard(db);
    const a = reserve(g, 300_000n);
    expect(a.ok).toBe(true);
    if (!a.ok) throw new Error("expected reservation");
    g.release(a.id, "VENDOR_ERROR");
    expect(g.snapshot()).toEqual({
      capMicro: CAP,
      reservedMicro: 0n,
      spentMicro: 0n,
      headroomMicro: CAP,
    });
    expect(reserve(g, 300_000n).ok).toBe(true);
  });

  it("hold then resolveHold settles or releases from the transaction lookup", () => {
    const db = tracked();
    const g = guard(db);
    const held = reserve(g, 25200n);
    const other = reserve(g, 10000n);
    expect(held.ok && other.ok).toBe(true);
    if (!held.ok || !other.ok) throw new Error("expected reservations");

    g.hold(held.id, "TIMEOUT");
    expect(g.snapshot().reservedMicro).toBe(35200n);

    g.resolveHold(held.id, { chargedMicro: 25200n, transactionId: "tx-1" });
    expect(g.snapshot()).toMatchObject({ reservedMicro: 10000n, spentMicro: 25200n });

    g.hold(other.id, "NETWORK_ERROR");
    g.resolveHold(other.id, null);
    expect(g.snapshot()).toEqual({
      capMicro: CAP,
      reservedMicro: 0n,
      spentMicro: 25200n,
      headroomMicro: CAP - 25200n,
    });
  });

  it("persists every transition to the ledger table before returning", () => {
    const db = tracked();
    const g = guard(db);
    const reserved = reserve(g, 50000n);
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) throw new Error("expected reservation");

    const row = db
      .prepare(`SELECT state, reserved_micro, charged_micro, idempotency_key FROM ledger WHERE id = ?`)
      .get(reserved.id) as { state: string; reserved_micro: string; charged_micro: string | null; idempotency_key: string };
    expect(row.state).toBe("reserved");
    expect(row.reserved_micro).toBe("50000");
    expect(row.charged_micro).toBeNull();
    expect(row.idempotency_key).toBe(reserved.idempotencyKey);

    g.settle(reserved.id, 40000n, "tx-persist", "failed");
    const settled = db.prepare(`SELECT state, charged_micro, transaction_id, perflo_code FROM ledger WHERE id = ?`).get(
      reserved.id,
    ) as {
      state: string;
      charged_micro: string;
      transaction_id: string;
      perflo_code: string;
    };
    expect(settled).toEqual({
      state: "settled",
      charged_micro: "40000",
      transaction_id: "tx-persist",
      perflo_code: "failed",
    });

    const reloaded = guard(db);
    expect(reloaded.snapshot()).toEqual(g.snapshot());
  });

  it("holds the planner reserve out of headroom until unlockReserve", () => {
    const db = tracked();
    const g = guard(db, "job-1", CAP, 100_000n);
    expect(g.snapshot().headroomMicro).toBe(900_000n);
    expect(reserve(g, 950_000n).ok).toBe(false);
    const ok = reserve(g, 900_000n);
    expect(ok.ok).toBe(true);
    g.unlockReserve();
    expect(g.snapshot().headroomMicro).toBe(100_000n);
    expect(reserve(g, 100_000n).ok).toBe(true);
  });

  it("relocks unused reserve after a disambiguation spend", () => {
    const db = tracked();
    const g = guard(db, "job-1", CAP, 100_000n);
    const first = reserve(g, 700_000n);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected reservation");
    g.settle(first.id, 700_000n, "tx-1", "succeeded");
    const before = g.snapshot().headroomMicro;
    expect(before).toBe(200_000n);
    g.unlockReserve();
    expect(g.snapshot().headroomMicro).toBe(300_000n);
    const disc = reserve(g, 150_000n);
    expect(disc.ok).toBe(true);
    if (!disc.ok) throw new Error("expected reservation");
    g.settle(disc.id, 150_000n, "tx-2", "succeeded");
    g.relockAfterUnlock(150_000n, before);
    expect(g.snapshot().headroomMicro).toBe(50_000n);
    expect(reserve(g, 60_000n).ok).toBe(false);
    expect(reserve(g, 50_000n).ok).toBe(true);
  });
});

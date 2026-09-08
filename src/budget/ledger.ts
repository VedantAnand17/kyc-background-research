// Spend Guard: the only component that can approve a paid call. PRD.md section 7, ADR-0002.
//
// Invariant: spentMicro + reservedMicro <= capMicro, always, including under concurrency.
// reserve() checks and updates in one synchronous SQLite transaction. Every transition is written
// to the `ledger` table before the caller makes its next network call.
//
// TODO(M5): copy snapshot.spentMicro onto jobs.spent_micro when the job finishes.
// TODO(M5): pass the pay outcome (succeeded/failed, or the Perflo code) into settle;
// the row currently stores the constant SETTLED.
import { randomUUID } from "node:crypto";
import type { Db } from "../db/sqlite.js";
import type { Micro } from "./money.js";

export type ReservationId = string;

export interface ReservationRequest {
  readonly vendor: string;
  readonly capability: string;
  readonly amountMicro: Micro;
}

export type ReserveResult =
  | { readonly ok: true; readonly id: ReservationId; readonly idempotencyKey: string }
  | { readonly ok: false; readonly reason: "budget_exhausted"; readonly headroomMicro: Micro };

export interface LedgerSnapshot {
  readonly capMicro: Micro;
  readonly reservedMicro: Micro;
  readonly spentMicro: Micro;
  readonly headroomMicro: Micro;
}

export interface SpendGuard {
  reserve(req: ReservationRequest): ReserveResult;
  settle(id: ReservationId, chargedMicro: Micro, transactionId: string | null): void;
  release(id: ReservationId, perfloCode: string): void;
  hold(id: ReservationId, perfloCode: string): void;
  /** Resolve a held reservation once GET /v1/transactions answers. */
  resolveHold(id: ReservationId, outcome: { readonly chargedMicro: Micro; readonly transactionId: string } | null): void;
  /** Release the planner's 10 percent disambiguation hold so later phases can spend it. */
  unlockReserve(): void;
  snapshot(): LedgerSnapshot;
}

export interface LedgerOptions {
  readonly db: Db;
  readonly jobId: string;
  readonly capMicro: Micro;
  /** Micro-dollars held back from phases 1-3; unlocked by the orchestrator for disambiguation. */
  readonly reserveMicro: Micro;
}

type LedgerState = "reserved" | "settled" | "released" | "held";

interface LedgerRow {
  readonly id: string;
  readonly reserved_micro: string;
  readonly charged_micro: string | null;
  readonly state: LedgerState;
}

function nowIso(): string {
  return new Date().toISOString();
}

function totalsFromRows(rows: readonly LedgerRow[]): { reserved: Micro; spent: Micro } {
  let reserved = 0n;
  let spent = 0n;
  for (const row of rows) {
    if (row.state === "reserved" || row.state === "held") reserved += BigInt(row.reserved_micro);
    if (row.state === "settled") spent += BigInt(row.charged_micro ?? "0");
  }
  return { reserved, spent };
}

export function createSpendGuard(opts: LedgerOptions): SpendGuard {
  if (opts.capMicro < 0n) throw new RangeError(`negative cap: ${opts.capMicro}`);
  if (opts.reserveMicro < 0n) throw new RangeError(`negative reserve: ${opts.reserveMicro}`);
  if (opts.reserveMicro > opts.capMicro) {
    throw new RangeError(`reserve ${opts.reserveMicro} exceeds cap ${opts.capMicro}`);
  }

  const { db, jobId, capMicro } = opts;
  let lockedReserve = opts.reserveMicro;

  const selectRows = db.prepare(`SELECT id, reserved_micro, charged_micro, state FROM ledger WHERE job_id = ?`);
  const selectRow = db.prepare(
    `SELECT id, reserved_micro, charged_micro, state FROM ledger WHERE id = ? AND job_id = ?`,
  );
  const insertRow = db.prepare(`
    INSERT INTO ledger (
      id, job_id, vendor, capability, idempotency_key, reserved_micro, charged_micro,
      state, transaction_id, perflo_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'reserved', NULL, NULL, ?, ?)
  `);
  const updateRow = db.prepare(`
    UPDATE ledger
    SET state = ?, charged_micro = ?, transaction_id = ?, perflo_code = ?, updated_at = ?
    WHERE id = ? AND job_id = ?
  `);

  function loadRows(): LedgerRow[] {
    return selectRows.all(jobId) as LedgerRow[];
  }

  function loadRow(id: ReservationId): LedgerRow {
    const row = selectRow.get(id, jobId) as LedgerRow | undefined;
    if (!row) throw new Error(`unknown reservation: ${id}`);
    return row;
  }

  function snapshotFrom(rows: readonly LedgerRow[]): LedgerSnapshot {
    const { reserved, spent } = totalsFromRows(rows);
    const rawHeadroom = capMicro - spent - reserved - lockedReserve;
    return {
      capMicro,
      reservedMicro: reserved,
      spentMicro: spent,
      headroomMicro: rawHeadroom < 0n ? 0n : rawHeadroom,
    };
  }

  const reserveTx = db.transaction((req: ReservationRequest): ReserveResult => {
    if (req.amountMicro <= 0n) throw new RangeError(`reserve amount must be positive: ${req.amountMicro}`);
    const snap = snapshotFrom(loadRows());
    if (snap.headroomMicro < req.amountMicro) {
      return { ok: false, reason: "budget_exhausted", headroomMicro: snap.headroomMicro };
    }
    const id = randomUUID();
    const idempotencyKey = randomUUID();
    const ts = nowIso();
    insertRow.run(id, jobId, req.vendor, req.capability, idempotencyKey, req.amountMicro.toString(), ts, ts);
    return { ok: true, id, idempotencyKey };
  });

  const settleTx = db.transaction((id: ReservationId, chargedMicro: Micro, transactionId: string | null): void => {
    if (chargedMicro < 0n) throw new RangeError(`negative charge: ${chargedMicro}`);
    const row = loadRow(id);
    if (row.state !== "reserved" && row.state !== "held") {
      throw new Error(`cannot settle reservation ${id} in state ${row.state}`);
    }
    const reserved = BigInt(row.reserved_micro);
    if (chargedMicro > reserved) {
      throw new RangeError(`charged ${chargedMicro} exceeds reserved ${reserved}`);
    }
    updateRow.run("settled", chargedMicro.toString(), transactionId, "SETTLED", nowIso(), id, jobId);
  });

  const releaseTx = db.transaction((id: ReservationId, perfloCode: string): void => {
    const row = loadRow(id);
    if (row.state !== "reserved" && row.state !== "held") {
      throw new Error(`cannot release reservation ${id} in state ${row.state}`);
    }
    updateRow.run("released", null, null, perfloCode, nowIso(), id, jobId);
  });

  const holdTx = db.transaction((id: ReservationId, perfloCode: string): void => {
    const row = loadRow(id);
    if (row.state !== "reserved") {
      throw new Error(`cannot hold reservation ${id} in state ${row.state}`);
    }
    updateRow.run("held", null, null, perfloCode, nowIso(), id, jobId);
  });

  return {
    reserve(req) {
      return reserveTx(req);
    },
    settle(id, chargedMicro, transactionId) {
      settleTx(id, chargedMicro, transactionId);
    },
    release(id, perfloCode) {
      releaseTx(id, perfloCode);
    },
    hold(id, perfloCode) {
      holdTx(id, perfloCode);
    },
    resolveHold(id, outcome) {
      if (outcome === null) releaseTx(id, "UNRECONCILED");
      else settleTx(id, outcome.chargedMicro, outcome.transactionId);
    },
    unlockReserve() {
      lockedReserve = 0n;
    },
    snapshot() {
      return snapshotFrom(loadRows());
    },
  };
}

-- Applied at startup with CREATE TABLE IF NOT EXISTS. PRD.md section 12.
-- All *_micro columns are integer micro-dollars stored as TEXT to preserve bigint exactly.

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  finished_at   TEXT,
  tier          TEXT NOT NULL CHECK (tier IN ('basic', 'standard', 'deep')),
  cap_micro     TEXT NOT NULL,
  spent_micro   TEXT NOT NULL DEFAULT '0',
  status        TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  request_json  TEXT NOT NULL,
  report_json   TEXT
);

CREATE TABLE IF NOT EXISTS ledger (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL REFERENCES jobs(id),
  vendor           TEXT NOT NULL,
  capability       TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE,
  reserved_micro   TEXT NOT NULL,
  charged_micro    TEXT,
  state            TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'released', 'held')),
  transaction_id   TEXT,
  perflo_code      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ledger_job_idx ON ledger(job_id);
CREATE INDEX IF NOT EXISTS ledger_state_idx ON ledger(state);

CREATE TABLE IF NOT EXISTS sources (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id),
  ledger_id       TEXT REFERENCES ledger(id),
  vendor          TEXT NOT NULL,
  capability      TEXT NOT NULL,
  purpose         TEXT NOT NULL,
  candidate_id    TEXT,
  status          TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  raw_json        TEXT NOT NULL,
  extracted_json  TEXT NOT NULL,
  retrieved_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sources_job_idx ON sources(job_id);

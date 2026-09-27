-- Migration number: 0001 record schema

CREATE TABLE kitchens (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('demo', 'scratch')),
  label TEXT CHECK (label IS NULL OR label IN ('capture', 'conformance')),
  time_zone TEXT NOT NULL,
  day_start TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- The retention sweep reads expired kitchens through this index, so a sweep on the public mint
-- route touches only the kitchens it deletes.
CREATE INDEX kitchens_expiry ON kitchens (kind, created_at);

INSERT INTO kitchens (id, kind, label, time_zone, day_start, created_at)
VALUES ('demo', 'demo', NULL, 'America/Chicago', '04:00', 0);

-- No foreign key to kitchens: retention deletes the kitchen row first and then its lines, in one
-- batch, and the delete guard in 0002 relies on that order.
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  kitchen_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reading', 'refusal', 'held', 'wrong_number', 'receipt')),
  occurred_at INTEGER NOT NULL,
  business_day TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  -- Only readings and refusals number the day's record lines. A pending question, a correction
  -- marker or a receipt takes none, so the printed codes of an append-only day never skip a number.
  day_line INTEGER,
  screen_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('person', 'seed')),
  check_point_id TEXT,
  measured TEXT,
  initials TEXT,
  words TEXT NOT NULL,
  value_tenths INTEGER,
  unit TEXT CHECK (unit IS NULL OR unit = 'F'),
  outcome TEXT NOT NULL,
  verdict TEXT,
  rule_id TEXT,
  rule_snapshot TEXT,
  rules_version TEXT,
  supersedes_id TEXT,
  root_id TEXT,
  ref_id TEXT,
  answers_id TEXT,
  prompt_kind TEXT,
  expires_at INTEGER,
  due_slot_id TEXT,
  due_at INTEGER,
  -- The whole tool result is stored with its event, so a retried call gets the first answer back
  -- byte for byte instead of being decided again against state its first run changed.
  result_json TEXT NOT NULL,
  args_hash TEXT NOT NULL
);

CREATE UNIQUE INDEX events_request ON events (kitchen_id, request_id);

CREATE UNIQUE INDEX events_day_line ON events (kitchen_id, business_day, day_line)
  WHERE day_line IS NOT NULL;

CREATE INDEX events_day ON events (kitchen_id, business_day, seq);

-- Supersede once and answer once are held by the database, never by a read before the write.
CREATE UNIQUE INDEX events_supersedes ON events (supersedes_id) WHERE supersedes_id IS NOT NULL;

CREATE UNIQUE INDEX events_answers ON events (answers_id) WHERE answers_id IS NOT NULL;

CREATE TABLE budget (
  utc_date TEXT PRIMARY KEY,
  rows INTEGER NOT NULL
);

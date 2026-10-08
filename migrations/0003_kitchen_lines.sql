-- Migration number: 0003 kitchen line counter

-- Each append checks the kitchen's line cap. Counting its events for that check read every line the
-- kitchen held, on refused calls too, and reads are not budgeted, so the count is kept here and read
-- by key. It is bookkeeping, like budget, not the record: the append-only triggers do not cover it.
-- The append raises it in the same batch as the event and only when the event landed, and retention
-- deletes it with its kitchen.
CREATE TABLE kitchen_lines (
  kitchen_id TEXT PRIMARY KEY,
  lines INTEGER NOT NULL
);

INSERT INTO kitchen_lines (kitchen_id, lines)
SELECT kitchen_id, COUNT(*) FROM events GROUP BY kitchen_id;

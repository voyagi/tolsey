-- Migration number: 0004 bounded reads

-- Reads are not budgeted, so each read a call makes must stay a handful of rows however busy its
-- kitchen is. "Wrong number" read the screen's newest event through the kitchen's events and counted
-- the corrections of every candidate before picking the newest, and an answer counted its chain's
-- misses by walking the kitchen. These three indexes let each of those reads seek straight to its rows.
-- Every row they cover writes one more index row, which rows-per-write.json measures and the daily
-- budget reserves.

-- The newest event a screen wrote, receipts left out. The read names kind <> 'receipt' word for word,
-- which is what lets SQLite use this partial index.
CREATE INDEX events_screen ON events (kitchen_id, screen_id, seq) WHERE kind <> 'receipt';

-- The events naming a line or a prompt: the wrong_number events that said a line wrong, and the holds
-- and refusals on a digit-repeat chain, which name its head.
CREATE INDEX events_ref ON events (ref_id, kind) WHERE ref_id IS NOT NULL;

-- The lines of a correction chain, which name its root.
CREATE INDEX events_root ON events (root_id) WHERE root_id IS NOT NULL;

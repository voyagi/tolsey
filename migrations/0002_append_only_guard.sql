-- Migration number: 0002 append-only guard

-- Kept alone in its own file: triggers are proven on local D1 only, and a remote refusal here must
-- never block the schema in 0001.

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

-- Retention deletes the kitchen row first and then its lines in the same batch, so a line can only
-- be deleted once its kitchen is gone.
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
WHEN EXISTS (SELECT 1 FROM kitchens WHERE id = OLD.kitchen_id)
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

-- A kitchen's time zone and day start decide every business day already written, so they never change.
CREATE TRIGGER kitchens_no_update BEFORE UPDATE ON kitchens
BEGIN
  SELECT RAISE(ABORT, 'kitchens are fixed once created');
END;

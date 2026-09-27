import type { D1Like, RowsPerWrite } from '../store/port';
import { addToBudget, utcDate } from './budget';
import type { StoreLimits } from './data';

export interface SweepRound {
  kitchensDeleted: number;
  rowsCounted: number;
}

export interface SweepRun {
  rounds: number;
  kitchensDeleted: number;
}

const HOUR_MS = 3_600_000;
const NOTHING_DELETED: SweepRound = { kitchensDeleted: 0, rowsCounted: 0 };

// Served by the kitchens_expiry index on (kind, created_at), so a round reads only the kitchens it
// is about to delete, never the live ones.
const SELECT_EXPIRED = `
SELECT id FROM kitchens WHERE kind = 'scratch' AND created_at <= ?1 ORDER BY created_at LIMIT ?2`;

// The only DELETE statements in the codebase, both over one bound JSON array of ids, so a round is
// two statements whatever its size (the free plan allows 50 queries per Worker invocation). The
// kitchens go first: migration 0002 lets an events row go only once its kitchen row is gone.
export const DELETE_EXPIRED_KITCHENS = `DELETE FROM kitchens WHERE id IN (SELECT value FROM json_each(?1))`;
export const DELETE_EXPIRED_EVENTS = `DELETE FROM events WHERE kitchen_id IN (SELECT value FROM json_each(?1))`;

// One bounded round. The budget add is a second call because no statement inside the batch can see
// the batch's rows written; the budget is a counter, not the record, so a crash between the two calls
// leaves one sweep uncounted rather than any line undeleted.
export async function expireKitchens(
  db: D1Like,
  now: number,
  limits: StoreLimits,
  rowsPerWrite: RowsPerWrite,
  roundSize: number,
): Promise<SweepRound> {
  const cutoff = now - limits.retentionAgeHours * HOUR_MS;
  const expired = await db.prepare(SELECT_EXPIRED).bind(cutoff, roundSize).all<{ id: string }>();
  if (expired.results.length === 0) return NOTHING_DELETED;

  const ids = JSON.stringify(expired.results.map((row) => row.id));
  const [kitchens, events] = await db.batch([
    db.prepare(DELETE_EXPIRED_KITCHENS).bind(ids),
    db.prepare(DELETE_EXPIRED_EVENTS).bind(ids),
  ]);
  const rowsDeleted = kitchens.meta.rows_written + events.meta.rows_written;
  // A concurrent round (another mint's, or the hourly run's) took these kitchens between the read and
  // the batch: there is nothing to count.
  if (rowsDeleted === 0) return NOTHING_DELETED;

  const rowsCounted = rowsDeleted + rowsPerWrite.budget_add;
  await addToBudget(db, utcDate(now), rowsCounted);
  return { kitchensDeleted: kitchens.meta.changes, rowsCounted };
}

// The hourly Cron Trigger's run: rounds until one comes back short or the round cap is reached, which
// keeps a run under the per-invocation query limit while still clearing every kitchen a day can mint.
export async function runScheduledSweep(
  db: D1Like,
  now: number,
  limits: StoreLimits,
  rowsPerWrite: RowsPerWrite,
): Promise<SweepRun> {
  let rounds = 0;
  let kitchensDeleted = 0;
  while (rounds < limits.maxSweepRounds) {
    rounds += 1;
    const round = await expireKitchens(db, now, limits, rowsPerWrite, limits.cronSweepBatchLimit);
    kitchensDeleted += round.kitchensDeleted;
    if (round.kitchensDeleted < limits.cronSweepBatchLimit) break;
  }
  return { rounds, kitchensDeleted };
}

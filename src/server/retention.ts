import type { D1Like, RowsPerWrite } from '../store/port';
import { addToBudget, utcDate } from './budget';
import type { StoreLimits } from './data';

export interface SweepRound {
  kitchensRead: number;
  kitchensDeleted: number;
  rowsCounted: number;
}

export interface SweepRun {
  rounds: number;
  kitchensDeleted: number;
}

const HOUR_MS = 3_600_000;

// Served by the kitchens_expiry index on (kind, created_at), so a round reads only the kitchens it
// is about to delete, never the live ones.
const SELECT_EXPIRED = `
SELECT id FROM kitchens WHERE kind = 'scratch' AND created_at <= ?1 ORDER BY created_at LIMIT ?2`;

// The only DELETE statements in the codebase, all over one bound JSON array of ids, so a round's
// delete batch is three statements whatever its size (the free plan allows 50 queries per Worker
// invocation). The kitchens go first: migration 0002 lets an events row go only once its kitchen row
// is gone. The line counter goes with them, so no row naming a deleted kitchen is left behind.
export const DELETE_EXPIRED_KITCHENS = `DELETE FROM kitchens WHERE id IN (SELECT value FROM json_each(?1))`;
export const DELETE_EXPIRED_EVENTS = `DELETE FROM events WHERE kitchen_id IN (SELECT value FROM json_each(?1))`;
export const DELETE_EXPIRED_LINE_COUNTS = `DELETE FROM kitchen_lines WHERE kitchen_id IN (SELECT value FROM json_each(?1))`;

// One bounded round. The budget add is a second call because no statement inside the batch can see
// the batch's rows written; the budget is a counter, not the record, so a crash between the two calls
// leaves one sweep uncounted rather than any line undeleted. `now` decides what has expired, and the
// rows are charged to the UTC date `chargedAt` reads once the batch has run, because the allowance
// counts a write on the day it happens. A mint's round runs at its own instant, so the two are one.
export async function expireKitchens(
  db: D1Like,
  now: number,
  limits: StoreLimits,
  rowsPerWrite: RowsPerWrite,
  roundSize: number,
  chargedAt: () => number = () => now,
): Promise<SweepRound> {
  const cutoff = now - limits.retentionAgeHours * HOUR_MS;
  const expired = await db.prepare(SELECT_EXPIRED).bind(cutoff, roundSize).all<{ id: string }>();
  const kitchensRead = expired.results.length;
  if (kitchensRead === 0) return { kitchensRead, kitchensDeleted: 0, rowsCounted: 0 };

  const ids = JSON.stringify(expired.results.map((row) => row.id));
  const deleted = await db.batch([
    db.prepare(DELETE_EXPIRED_KITCHENS).bind(ids),
    db.prepare(DELETE_EXPIRED_EVENTS).bind(ids),
    db.prepare(DELETE_EXPIRED_LINE_COUNTS).bind(ids),
  ]);
  const [kitchens] = deleted;
  const rowsDeleted = deleted.reduce((sum, result) => sum + result.meta.rows_written, 0);
  // A concurrent round (another mint's, or the hourly run's) took these kitchens between the read and
  // the batch: there is nothing to count.
  if (rowsDeleted === 0) return { kitchensRead, kitchensDeleted: 0, rowsCounted: 0 };

  const rowsCounted = rowsDeleted + rowsPerWrite.budget_add;
  await addToBudget(db, utcDate(chargedAt()), rowsCounted);
  return { kitchensRead, kitchensDeleted: kitchens.meta.changes, rowsCounted };
}

// The hourly Cron Trigger's run: rounds until one reads a short page or the round cap is reached, which
// keeps a run under the per-invocation query limit while still clearing every kitchen a day can mint.
// A round that deleted less than it read lost part of its page to a concurrent round; older kitchens
// can still be waiting, so only a short read ends the run. `now` is the trigger's scheduled instant and
// `chargedAt` the Worker's clock: a run that starts late, past 00:00 UTC, deletes by the hour it was
// scheduled for and charges the day it ran on.
export async function runScheduledSweep(
  db: D1Like,
  now: number,
  limits: StoreLimits,
  rowsPerWrite: RowsPerWrite,
  chargedAt: () => number,
): Promise<SweepRun> {
  let rounds = 0;
  let kitchensDeleted = 0;
  while (rounds < limits.maxSweepRounds) {
    rounds += 1;
    const round = await expireKitchens(db, now, limits, rowsPerWrite, limits.cronSweepBatchLimit, chargedAt);
    kitchensDeleted += round.kitchensDeleted;
    if (round.kitchensRead < limits.cronSweepBatchLimit) break;
  }
  return { rounds, kitchensDeleted };
}

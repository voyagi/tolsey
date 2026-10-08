import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D1Store } from '../store/d1-store';
import type { D1Like } from '../store/port';
import { countingD1, type CountingD1 } from '../test-support/counting-d1';
import {
  appendInput,
  HOUR_MS,
  insertLines,
  insertScratchKitchens,
  kitchenInput,
  readLimits,
  readRowsPerWrite,
  scratchKitchen,
  testEvent,
  type StoreLimits,
} from '../test-support/events';
import { callLogReading, walkInArguments, type ToolResult } from '../test-support/mcp-client';
import { mintThroughRoute, openInProcessWorker, type InProcessWorker } from '../test-support/target';
import { addToBudget } from './budget';
import { DEMO_PROFILE } from './data';
import { deletionBoundMs, handleKitchensRoute, writeWindowMs } from './kitchens';
import {
  DELETE_EXPIRED_EVENTS,
  DELETE_EXPIRED_KITCHENS,
  DELETE_EXPIRED_LINE_COUNTS,
  expireKitchens,
  runScheduledSweep,
} from './retention';

// 10:00 CDT on 2026-10-20; its UTC date is the budget row every write in these tests counts against.
const T0 = Date.UTC(2026, 9, 20, 15, 0);
const T0_DATE = '2026-10-20';
const MINUTE_MS = 60_000;
const D1_QUERIES_PER_INVOCATION = 50;
// The expired read, the three deletes of its batch and the budget add.
const STATEMENTS_PER_ROUND = 5;
const DEMO_FULL = 'The demo is full for today. Try the replay.';
const KITCHEN_FULL = 'This kitchen is full. Start a new kitchen to keep logging.';
const KITCHEN_CLOSED = 'This kitchen has closed. Start a new kitchen to keep logging.';

describe('the daily row budget, the kitchen caps and retention', () => {
  let worker: InProcessWorker;
  const limits: StoreLimits = readLimits();
  const rowsPerWrite = readRowsPerWrite();

  beforeEach(async () => {
    worker = await openInProcessWorker();
    worker.clock.set(T0);
  });

  afterEach(async () => {
    await worker?.dispose();
  });

  async function budgetRows(utcDate = T0_DATE): Promise<number> {
    const row = await worker.db.prepare('SELECT rows FROM budget WHERE utc_date = ?1').bind(utcDate).first<{ rows: number }>();
    return row?.rows ?? 0;
  }

  async function setBudget(rows: number, utcDate = T0_DATE): Promise<void> {
    await worker.db
      .prepare('INSERT INTO budget (utc_date, rows) VALUES (?1, ?2) ON CONFLICT (utc_date) DO UPDATE SET rows = excluded.rows')
      .bind(utcDate, rows)
      .run();
  }

  async function count(query: string, ...values: unknown[]): Promise<number> {
    const row = await worker.db.prepare(query).bind(...values).first<{ n: number }>();
    return row?.n ?? -1;
  }

  const eventsOf = (kitchenId: string) => count('SELECT COUNT(*) AS n FROM events WHERE kitchen_id = ?1', kitchenId);
  const kitchenExists = async (kitchenId: string) =>
    (await count('SELECT COUNT(*) AS n FROM kitchens WHERE id = ?1', kitchenId)) === 1;
  const scratchKitchens = () => count("SELECT COUNT(*) AS n FROM kitchens WHERE kind = 'scratch'");

  async function logAt(instant: number, mcpPath: string, args = walkInArguments()): Promise<ToolResult> {
    worker.clock.set(instant);
    return callLogReading(worker.fetch, new URL(mcpPath, worker.baseUrl), args);
  }

  function kitchensDeps(db: D1Like) {
    const settings = { timeZone: DEMO_PROFILE.timeZone, dayStart: DEMO_PROFILE.dayStart };
    return { store: new D1Store(db), db, clock: worker.clock, limits, rowsPerWrite, settings };
  }

  async function mintDirectly(db: D1Like): Promise<Response> {
    return handleKitchensRoute('POST', { kind: 'json', value: {} }, kitchensDeps(db));
  }

  async function expiredKitchenWithLines(lines: number, createdAt = T0 - 24 * HOUR_MS): Promise<string> {
    const [id] = await insertScratchKitchens(worker.db, [createdAt]);
    await insertLines(worker.db, id, lines, createdAt + MINUTE_MS);
    return id;
  }

  function deleteBatchRows(counted: CountingD1): number {
    const batch = counted.batches.find((each) => each.queries.some((query) => query.includes('DELETE')));
    return batch ? batch.results.reduce((sum, result) => sum + result.meta.rows_written, 0) : 0;
  }

  describe('the daily budget and the kitchen caps', () => {
    it('refuses a reading that would take the day past 40,000 rows with the spoken reason and writes nothing (E28)', async () => {
      const minted = await mintThroughRoute(worker.fetch, worker.baseUrl);
      await setBudget(limits.dailyRowCap - (rowsPerWrite.event_first_of_day - 1));

      const result = await logAt(T0, minted.mcpPath);

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: DEMO_FULL }]);
      expect(await eventsOf(minted.id)).toBe(0);
      expect(await budgetRows()).toBe(limits.dailyRowCap - (rowsPerWrite.event_first_of_day - 1));
    });

    it('answers POST /api/kitchens at the cap with 503 demo_full and inserts nothing', async () => {
      await setBudget(limits.dailyRowCap);
      const before = await scratchKitchens();

      const response = await worker.fetch(new URL('/api/kitchens', worker.baseUrl), { method: 'POST' });

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'demo_full', message: DEMO_FULL });
      expect(await scratchKitchens()).toBe(before);
      expect(await budgetRows()).toBe(limits.dailyRowCap);
    });

    it('keeps the counted day at or under the cap when two concurrent writes would together pass it', async () => {
      const minted = await mintThroughRoute(worker.fetch, worker.baseUrl);
      await setBudget(limits.dailyRowCap - 2 * rowsPerWrite.event_first_of_day + 1);

      const results = await Promise.all([logAt(T0, minted.mcpPath), logAt(T0, minted.mcpPath)]);

      expect(results.filter((result) => result.isError).length).toBeGreaterThanOrEqual(1);
      expect(await budgetRows()).toBeLessThanOrEqual(limits.dailyRowCap);
    });

    it('refuses the next write to a kitchen holding kitchenLineCap lines, saying the kitchen is full', async () => {
      const minted = await mintThroughRoute(worker.fetch, worker.baseUrl);
      await insertLines(worker.db, minted.id, limits.kitchenLineCap, T0);

      const result = await logAt(T0, minted.mcpPath);

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: KITCHEN_FULL }]);
      expect(await eventsOf(minted.id)).toBe(limits.kitchenLineCap);
    });

    // Reads are not budgeted, so their cost per call is held here (ADR 0002, rows read). The line cap
    // reads the kitchen's counter row, where counting its events walked every line (159 rows at 150
    // lines on local D1), and the next line number comes from the day-line index, never from a walk
    // over the day.
    it('reads a handful of rows for an accepted reading, however many lines the kitchen holds', async () => {
      const kitchen = scratchKitchen();
      await worker.store.createKitchen(kitchenInput(kitchen, limits));
      const lines = 150;
      await insertLines(worker.db, kitchen.id, lines, kitchen.createdAt + MINUTE_MS);
      const counted = countingD1(worker.db);

      const outcome = await new D1Store(counted.db).append(appendInput(testEvent(kitchen.id), limits));

      expect(outcome.status).toBe('appended');
      expect(counted.totals().rowsRead).toBeLessThanOrEqual(12);
    });

    // Every answer reads its pending prompt first. Only a digit repeat needs its chain counted, and
    // that count walks the kitchen's events; any other question is one indexed read (153 rows at 150
    // lines before the count moved behind the digit-repeat branch).
    it('reads one row for a pending question and walks the kitchen only for a digit repeat', async () => {
      const minted = await mintThroughRoute(worker.fetch, worker.baseUrl);
      const lines = 150;
      await insertLines(worker.db, minted.id, lines, T0);
      const url = new URL(minted.mcpPath, worker.baseUrl);
      const ask = async (args: Record<string, unknown>): Promise<string> => {
        const result = await callLogReading(worker.fetch, url, { screen_id: 'budget-wall', request_id: crypto.randomUUID(), ...args });
        return (result.structuredContent?.prompt as { id: string }).id;
      };
      const whoIsLogging = await ask({ check_point: 'walk_in', value: 38 });
      const digitRepeat = await ask({ check_point: 'walk_in', value: 15, initials: 'AB' });
      const readsFor = async (promptId: string): Promise<number> => {
        const counted = countingD1(worker.db);
        expect(await new D1Store(counted.db).pendingPrompt(minted.id, promptId)).not.toBeNull();
        return counted.totals().rowsRead;
      };

      expect(await readsFor(whoIsLogging)).toBeLessThanOrEqual(2);
      expect(await readsFor(digitRepeat)).toBeLessThan(1.5 * lines);
    });

    // "Wrong number" reads the screen's newest event and, for a reading, counts the corrections along
    // its chain. Both are held to the kitchen's own lines: a busier kitchen written later must not be
    // walked on the way. Measured 303 rows at 151 lines on local D1 (2026-09-30), one walk for each;
    // a third walk, or a scan down the whole table, goes past the bound.
    it('reads no more than the kitchen lines for "wrong number", however many lines another kitchen holds', async () => {
      const kitchen = scratchKitchen();
      await worker.store.createKitchen(kitchenInput(kitchen, limits));
      const lines = 150;
      await insertLines(worker.db, kitchen.id, lines, kitchen.createdAt + MINUTE_MS);
      const reading = testEvent(kitchen.id, { screenId: 'budget-wall' });
      await worker.store.append(appendInput(reading, limits));
      const [busier] = await insertScratchKitchens(worker.db, [kitchen.createdAt]);
      await insertLines(worker.db, busier, 1000, kitchen.createdAt + MINUTE_MS);
      const counted = countingD1(worker.db);

      const latest = await new D1Store(counted.db).latestByScreen(kitchen.id, 'budget-wall', kitchen.createdAt);

      expect(latest).toMatchObject({ id: reading.id, kind: 'reading', corrections: 0 });
      expect(counted.totals().rowsRead).toBeLessThan(2.5 * lines);
    });

    it('accepts a write 1 ms inside the write window and refuses one at its end, saying the kitchen has closed', async () => {
      const minted = await mintThroughRoute(worker.fetch, worker.baseUrl);

      const inside = await logAt(T0 + writeWindowMs(limits) - 1, minted.mcpPath);
      const atEnd = await logAt(T0 + writeWindowMs(limits), minted.mcpPath);

      expect(inside.isError).toBeFalsy();
      expect(atEnd.isError).toBe(true);
      expect(atEnd.content).toEqual([{ type: 'text', text: KITCHEN_CLOSED }]);
      expect(await eventsOf(minted.id)).toBe(1);
    });

    it('closes writes early enough that the retry window of the last write ends before retention age', () => {
      expect(writeWindowMs(limits) + limits.retryWindowSeconds * 1000).toBeLessThanOrEqual(
        limits.retentionAgeHours * HOUR_MS,
      );
    });

    // PRIV-03 promises deletion within 24 hours. A kitchen past retention age waits for the next hourly
    // run, and that run can start after the hour it was scheduled for: the platform hands it the
    // scheduled instant and documents no start guarantee, so the age leaves room for a late start.
    // The mint reports this same bound as expiresAt, so it must count the whole wait.
    it('deletes every scratch kitchen within 24 hours even when the hourly run starts 15 minutes late (PRIV-03)', () => {
      const lateStartAllowanceMs = 15 * MINUTE_MS;
      expect(deletionBoundMs(limits)).toBeGreaterThanOrEqual(
        limits.retentionAgeHours * HOUR_MS + HOUR_MS + lateStartAllowanceMs,
      );
      expect(deletionBoundMs(limits)).toBeLessThanOrEqual(24 * HOUR_MS);
    });
  });

  describe('a sweep round', () => {
    it('deletes an expired kitchen with its lines and adds exactly its delete batch rows plus budget_add', async () => {
      const kitchenId = await expiredKitchenWithLines(4);
      const counted = countingD1(worker.db);
      const before = await budgetRows();

      const round = await expireKitchens(counted.db, T0, limits, rowsPerWrite, limits.sweepBatchLimit);

      expect(deleteBatchRows(counted)).toBeGreaterThanOrEqual(5);
      expect(round).toEqual({
        kitchensRead: 1,
        kitchensDeleted: 1,
        rowsCounted: deleteBatchRows(counted) + rowsPerWrite.budget_add,
      });
      expect(await budgetRows()).toBe(before + round.rowsCounted);
      expect(await kitchenExists(kitchenId)).toBe(false);
      expect(await eventsOf(kitchenId)).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM kitchen_lines WHERE kitchen_id = ?1', kitchenId)).toBe(0);
    });

    // ADR 0002 derives retention's daily ceiling from this figure: one row per deleted kitchen, one for
    // its line counter and one per deleted line, whatever indexes the line filled when it was written.
    // Ten readings through the reference client took 6.1 s on a loaded machine, past the 5 s default.
    it('counts one row per deleted kitchen, its line counter and per deleted reading, plus budget_add', { timeout: 30_000 }, async () => {
      const minted = await mintThroughRoute(worker.fetch, worker.baseUrl);
      const readings = 10;
      for (let index = 0; index < readings; index++) {
        expect((await logAt(T0, minted.mcpPath)).isError).toBeFalsy();
      }

      const round = await expireKitchens(worker.db, T0 + 24 * HOUR_MS, limits, rowsPerWrite, limits.sweepBatchLimit);

      expect(round.kitchensDeleted).toBe(1);
      expect(round.rowsCounted).toBe(2 + readings + rowsPerWrite.budget_add);
    });

    it('runs one read and no write when nothing has expired', async () => {
      await insertScratchKitchens(worker.db, [T0 - HOUR_MS]);
      const counted = countingD1(worker.db);

      const round = await expireKitchens(counted.db, T0, limits, rowsPerWrite, limits.sweepBatchLimit);

      expect(round).toEqual({ kitchensRead: 0, kitchensDeleted: 0, rowsCounted: 0 });
      expect(counted.statements).toHaveLength(1);
      expect(counted.totals().rowsWritten).toBe(0);
      expect(await budgetRows()).toBe(0);
    });

    it('reads fewer rows than a live kitchen of 150 lines holds while deleting an expired kitchen beside it', async () => {
      const [live] = await insertScratchKitchens(worker.db, [T0 - HOUR_MS]);
      await insertLines(worker.db, live, 150, T0 - HOUR_MS + MINUTE_MS);
      const expired = await expiredKitchenWithLines(3);
      const counted = countingD1(worker.db);

      const round = await expireKitchens(counted.db, T0, limits, rowsPerWrite, limits.sweepBatchLimit);

      expect(round.kitchensDeleted).toBe(1);
      expect(await kitchenExists(expired)).toBe(false);
      expect(await eventsOf(live)).toBe(150);
      expect(counted.totals().rowsRead).toBeLessThan(150);
    });

    it('deletes nothing and writes no budget row when a concurrent round already took the kitchens it read', async () => {
      const taken = await expiredKitchenWithLines(2);
      await expireKitchens(worker.db, T0, limits, rowsPerWrite, limits.sweepBatchLimit);
      const before = await budgetRows();
      const stale = countingD1(worker.db, (query) => (query.includes('SELECT id FROM kitchens') ? [{ id: taken }] : undefined));

      const round = await expireKitchens(stale.db, T0, limits, rowsPerWrite, limits.sweepBatchLimit);

      expect(round).toEqual({ kitchensRead: 1, kitchensDeleted: 0, rowsCounted: 0 });
      expect(stale.statements.map((statement) => statement.via)).toEqual(['all', 'batch', 'batch', 'batch']);
      expect(await budgetRows()).toBe(before);
    });

    it.each([1, 25, 60])('runs at most five statements over %i expired kitchens', async (expired) => {
      await insertScratchKitchens(worker.db, Array.from({ length: expired }, (_, index) => T0 - 24 * HOUR_MS - index));
      const counted = countingD1(worker.db);

      const round = await expireKitchens(counted.db, T0, limits, rowsPerWrite, 60);

      expect(round.kitchensDeleted).toBe(expired);
      expect(counted.statements.length).toBeLessThanOrEqual(STATEMENTS_PER_ROUND);
    });

    it('shows an index search, never a scan of events, in the query plans of every delete', async () => {
      const plans = await Promise.all(
        [DELETE_EXPIRED_KITCHENS, DELETE_EXPIRED_EVENTS, DELETE_EXPIRED_LINE_COUNTS].map(async (sql) => {
          const explain = 'EXPLAIN QUERY PLAN ' + sql;
          const rows = await worker.db.prepare(explain).bind('["a"]').all<{ detail: string }>();
          return rows.results.map((row) => row.detail).join(' / ');
        }),
      );
      console.log(`query plans\nkitchens: ${plans[0]}\nevents: ${plans[1]}\nkitchen_lines: ${plans[2]}`);

      expect(plans[0]).toMatch(/SEARCH kitchens USING (COVERING )?INDEX/);
      expect(plans[1]).toMatch(/SEARCH events USING (COVERING )?INDEX/);
      expect(plans[2]).toMatch(/SEARCH kitchen_lines USING (COVERING )?INDEX/);
      expect(plans.join(' ')).not.toMatch(/SCAN (events|kitchens|kitchen_lines)\b/);
    });

    it('measures the rows the sweep budget add writes as the first write of a UTC date equal to budget_add', async () => {
      const counted = countingD1(worker.db);

      await addToBudget(counted.db, '2031-01-01', 5);

      expect(counted.totals().rowsWritten).toBe(rowsPerWrite.budget_add);
    });
  });

  describe('minting and the sweep', () => {
    it('runs exactly one statement, the budget read, for a mint refused at that read, and writes nothing', async () => {
      await expiredKitchenWithLines(3);
      await setBudget(limits.dailyRowCap);
      const counted = countingD1(worker.db);

      const response = await mintDirectly(counted.db);

      expect(response.status).toBe(503);
      expect(counted.statements).toHaveLength(1);
      expect(counted.totals().rowsRead).toBeLessThanOrEqual(2);
      expect(counted.totals().rowsWritten).toBe(0);
      expect(await scratchKitchens()).toBe(1);
    });

    it('mints a kitchen in the zone and day start of the profile it copies, never a second default', async () => {
      const deps = { ...kitchensDeps(worker.db), settings: { timeZone: 'Europe/Amsterdam', dayStart: '05:00' } };

      const response = await handleKitchensRoute('POST', { kind: 'json', value: {} }, deps);

      const { id } = (await response.json()) as { id: string };
      const row = await worker.db
        .prepare('SELECT time_zone, day_start FROM kitchens WHERE id = ?1')
        .bind(id)
        .first<{ time_zone: string; day_start: string }>();
      expect(row).toEqual({ time_zone: 'Europe/Amsterdam', day_start: '05:00' });
    });

    it('adds exactly the kitchen_create figure to the budget for an accepted mint with nothing expired', async () => {
      const counted = countingD1(worker.db);

      const response = await mintDirectly(counted.db);

      expect(response.status).toBe(201);
      expect(await budgetRows()).toBe(rowsPerWrite.kitchen_create);
      expect(counted.statements).toHaveLength(4);
    });

    it('sweeps three expired kitchens of five lines on an accepted mint and leaves the live one', async () => {
      const expired = await Promise.all([1, 2, 3].map(() => expiredKitchenWithLines(5)));
      const [live] = await insertScratchKitchens(worker.db, [T0 - HOUR_MS]);
      const counted = countingD1(worker.db);

      const response = await mintDirectly(counted.db);

      expect(response.status).toBe(201);
      for (const id of expired) expect(await kitchenExists(id)).toBe(false);
      expect(await kitchenExists(live)).toBe(true);
      expect(counted.statements.length).toBeLessThanOrEqual(8);
    });

    it('refuses a mint its own sweep pushed past the cap, counting that sweep and inserting no kitchen', async () => {
      await expiredKitchenWithLines(3);
      await setBudget(limits.dailyRowCap - rowsPerWrite.kitchen_create);
      const counted = countingD1(worker.db);

      const response = await mintDirectly(counted.db);

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'demo_full', message: DEMO_FULL });
      expect(await scratchKitchens()).toBe(0);
      expect(await budgetRows()).toBe(
        limits.dailyRowCap - rowsPerWrite.kitchen_create + deleteBatchRows(counted) + rowsPerWrite.budget_add,
      );
    });

    it('sweeps sweepBatchLimit kitchens on one mint and leaves the rest to the hourly handler', async () => {
      await insertScratchKitchens(
        worker.db,
        Array.from({ length: limits.sweepBatchLimit + 2 }, (_, index) => T0 - 24 * HOUR_MS - index),
      );

      await mintDirectly(worker.db);
      expect(await scratchKitchens()).toBe(2 + 1);

      const run = await runScheduledSweep(worker.db, T0, limits, rowsPerWrite);
      expect(run.kitchensDeleted).toBe(2);
      expect(await scratchKitchens()).toBe(1);
    });

    it('runs rounds of cronSweepBatchLimit until maxSweepRounds, then leaves the rest to the next run', async () => {
      const small: StoreLimits = { ...limits, cronSweepBatchLimit: 2, maxSweepRounds: 3 };
      await insertScratchKitchens(worker.db, Array.from({ length: 10 }, (_, index) => T0 - 24 * HOUR_MS - index));

      expect(await runScheduledSweep(worker.db, T0, small, rowsPerWrite)).toEqual({ rounds: 3, kitchensDeleted: 6 });
      expect((await runScheduledSweep(worker.db, T0, small, rowsPerWrite)).kitchensDeleted).toBe(4);
      expect(await scratchKitchens()).toBe(0);
    });

    // A mint's own round can delete the page the hourly run just read, so that round deletes less
    // than it read; only a short page means nothing older is left.
    it('keeps sweeping after a round whose full page a concurrent round took, until a page comes back short', async () => {
      const small: StoreLimits = { ...limits, cronSweepBatchLimit: 2, maxSweepRounds: 3 };
      const expired = await insertScratchKitchens(worker.db, [0, 1, 2].map((index) => T0 - 24 * HOUR_MS - index));
      let selects = 0;
      const raced = countingD1(worker.db, (query) => {
        if (!query.includes('SELECT id FROM kitchens')) return undefined;
        selects += 1;
        return selects === 1 ? [{ id: 'taken-a' }, { id: 'taken-b' }] : undefined;
      });

      const run = await runScheduledSweep(raced.db, T0, small, rowsPerWrite);

      expect(run).toEqual({ rounds: 3, kitchensDeleted: 3 });
      for (const id of expired) expect(await kitchenExists(id)).toBe(false);
    });

    it('lets one hourly run delete every kitchen the daily budget can mint, within the per-invocation query limit', () => {
      expect(limits.maxSweepRounds * limits.cronSweepBatchLimit).toBeGreaterThanOrEqual(
        Math.floor(limits.dailyRowCap / rowsPerWrite.kitchen_create),
      );
      expect(STATEMENTS_PER_ROUND * limits.maxSweepRounds).toBeLessThanOrEqual(D1_QUERIES_PER_INVOCATION);
    });
  });

  describe('the retry window against the sweep', () => {
    it('keeps the last accepted write retryable until its window ends, and the retention-age sweep deletes it after', async () => {
      const minted = await mintThroughRoute(worker.fetch, worker.baseUrl);
      const args = walkInArguments();
      const lastAccepted = await logAt(T0 + writeWindowMs(limits) - 1, minted.mcpPath, args);
      expect(lastAccepted.isError).toBeFalsy();

      const lastRetryInstant = T0 + limits.retentionAgeHours * HOUR_MS - 1;
      await expireKitchens(worker.db, lastRetryInstant, limits, rowsPerWrite, limits.sweepBatchLimit);
      expect(await kitchenExists(minted.id)).toBe(true);
      expect(await eventsOf(minted.id)).toBe(1);

      const retried = await logAt(lastRetryInstant, minted.mcpPath, args);
      expect(JSON.stringify(retried)).toBe(JSON.stringify(lastAccepted));

      await expireKitchens(worker.db, T0 + limits.retentionAgeHours * HOUR_MS, limits, rowsPerWrite, limits.sweepBatchLimit);
      expect(await kitchenExists(minted.id)).toBe(false);
      expect(await eventsOf(minted.id)).toBe(0);
    });
  });
});

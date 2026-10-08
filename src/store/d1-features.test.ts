import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeWindowMs } from '../server/kitchens';
import { countingD1, HANDFUL_OF_ROWS } from '../test-support/counting-d1';
import { migrationStatements, openTestD1, type TestD1 } from '../test-support/d1';
import {
  appendInput,
  insertLines,
  KITCHEN_CREATED_AT,
  kitchenInput,
  readLimits,
  readRowsPerWrite,
  RESULT_TEMPLATE,
  scratchKitchen,
  testEvent,
  type StoreLimits,
} from '../test-support/events';
import { D1Store } from './d1-store';
import {
  expectedRowsFor,
  type AppendOutcome,
  type D1Like,
  type D1ResultLike,
  type D1StatementLike,
  type EventKind,
  type NewEvent,
  type RowsPerWrite,
} from './port';

interface MeteredStatement extends D1StatementLike {
  inner: D1StatementLike;
}

// Records meta.rows_written of the last write the store made, summed over a batch's statements.
class RowsMeter {
  rows = 0;

  wrap(db: D1Like): D1Like {
    const record = (results: D1ResultLike<unknown>[]) => {
      this.rows = results.reduce((sum, result) => sum + result.meta.rows_written, 0);
    };
    const statement = (inner: D1StatementLike): MeteredStatement => ({
      inner,
      bind: (...values) => statement(inner.bind(...values)),
      first: <Row>() => inner.first<Row>(),
      all: <Row>() => inner.all<Row>(),
      run: async <Row>() => {
        const result = await inner.run<Row>();
        record([result]);
        return result;
      },
    });
    return {
      prepare: (query) => statement(db.prepare(query)),
      batch: async <Row>(statements: D1StatementLike[]) => {
        const results = await db.batch<Row>(statements.map((each) => (each as MeteredStatement).inner));
        record(results);
        return results;
      },
    };
  }
}

const EVENT_KINDS: EventKind[] = ['reading', 'refusal', 'held', 'wrong_number', 'receipt'];
const INDEX_SHAPES = ['none', 'supersedes', 'answers', 'both'] as const;
const NO_ROWS = { changes: 0, rows_read: 0, rows_written: 0, last_row_id: 0 };

// Local D1 always returns the follow-up read's one row, so only a stand-in can leave it empty: its
// batch writes nothing and every read finds no row.
function emptyD1(): D1Like {
  const statement: D1StatementLike = {
    bind: () => statement,
    first: async () => null,
    all: async () => ({ results: [], meta: NO_ROWS }),
    run: async () => ({ results: [], meta: NO_ROWS }),
  };
  return { prepare: () => statement, batch: async (statements) => statements.map(() => ({ results: [], meta: NO_ROWS })) };
}

function expectStatus<Status extends AppendOutcome['status']>(
  outcome: AppendOutcome,
  status: Status,
): Extract<AppendOutcome, { status: Status }> {
  expect(outcome.status).toBe(status);
  return outcome as Extract<AppendOutcome, { status: Status }>;
}

describe('what local D1 guarantees for the record', () => {
  let d1: TestD1;
  let store: D1Store;
  let limits: StoreLimits;

  beforeAll(async () => {
    d1 = await openTestD1();
    store = new D1Store(d1.db);
    limits = readLimits();
  });

  afterAll(async () => {
    await d1?.dispose();
  });

  async function freshKitchen(createdAt = KITCHEN_CREATED_AT): Promise<string> {
    const kitchen = scratchKitchen(createdAt);
    expect(await store.createKitchen(kitchenInput(kitchen, limits))).toEqual({ status: 'created' });
    return kitchen.id;
  }

  async function countEvents(kitchenId: string): Promise<number> {
    const row = await d1.db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE kitchen_id = ?1')
      .bind(kitchenId)
      .first<{ n: number }>();
    return row?.n ?? -1;
  }

  async function appendOne(kitchenId: string, overrides: Partial<NewEvent> = {}): Promise<NewEvent> {
    const event = testEvent(kitchenId, overrides);
    expectStatus(await store.append(appendInput(event, limits)), 'appended');
    return event;
  }

  it('refuses an UPDATE of an events row with the append-only trigger', async () => {
    const kitchenId = await freshKitchen();
    const event = await appendOne(kitchenId);

    await expect(
      d1.db.prepare("UPDATE events SET words = 'edited' WHERE id = ?1").bind(event.id).run(),
    ).rejects.toThrow(/SQLITE_CONSTRAINT_TRIGGER/);
  });

  it('refuses a DELETE of an events row while its kitchen row still exists', async () => {
    const kitchenId = await freshKitchen();
    const event = await appendOne(kitchenId);

    await expect(d1.db.prepare('DELETE FROM events WHERE id = ?1').bind(event.id).run()).rejects.toThrow(
      /SQLITE_CONSTRAINT_TRIGGER/,
    );
    expect(await countEvents(kitchenId)).toBe(1);
  });

  it('lets retention delete the kitchen row and then its events in one batch', async () => {
    const kitchenId = await freshKitchen();
    await appendOne(kitchenId);
    await appendOne(kitchenId);

    await d1.db.batch([
      d1.db.prepare('DELETE FROM kitchens WHERE id = ?1').bind(kitchenId),
      d1.db.prepare('DELETE FROM events WHERE kitchen_id = ?1').bind(kitchenId),
    ]);
    expect(await countEvents(kitchenId)).toBe(0);
    expect(await store.findKitchen(kitchenId)).toBeNull();
  });

  it('refuses an UPDATE of a kitchens row, so its time zone and day start stay as created', async () => {
    const kitchenId = await freshKitchen();

    await expect(
      d1.db.prepare("UPDATE kitchens SET time_zone = 'UTC' WHERE id = ?1").bind(kitchenId).run(),
    ).rejects.toThrow(/SQLITE_CONSTRAINT_TRIGGER/);
    expect((await store.findKitchen(kitchenId))?.timeZone).toBe('America/Chicago');
  });

  it('returns conflict supersedes for a second event superseding the same line and writes nothing', async () => {
    const kitchenId = await freshKitchen();
    const original = await appendOne(kitchenId);
    await appendOne(kitchenId, { supersedesId: original.id });

    const second = testEvent(kitchenId, { supersedesId: original.id });
    expect(await store.append(appendInput(second, limits))).toEqual({ status: 'conflict', constraint: 'supersedes' });
    expect(await countEvents(kitchenId)).toBe(2);
  });

  it('returns conflict answers for a second event answering the same prompt and writes nothing', async () => {
    const kitchenId = await freshKitchen();
    const prompt = await appendOne(kitchenId, { kind: 'held', promptKind: 'digits' });
    await appendOne(kitchenId, { answersId: prompt.id });

    const second = testEvent(kitchenId, { answersId: prompt.id });
    expect(await store.append(appendInput(second, limits))).toEqual({ status: 'conflict', constraint: 'answers' });
    expect(await countEvents(kitchenId)).toBe(2);
  });

  it('returns duplicate, not conflict, for a retried correction that also trips the supersedes index', async () => {
    const kitchenId = await freshKitchen();
    const original = await appendOne(kitchenId);
    const correction = await appendOne(kitchenId, { supersedesId: original.id, requestId: 'correct-1' });

    const retry = testEvent(kitchenId, { supersedesId: original.id, requestId: 'correct-1' });
    const outcome = expectStatus(await store.append(appendInput(retry, limits)), 'duplicate');
    const stored = (await store.linesForDay(kitchenId, correction.businessDay)).find((line) => line.id === correction.id);
    expect(outcome.resultJson).toBe(stored?.resultJson);
    expect(await countEvents(kitchenId)).toBe(2);
  });

  it('returns duplicate with the stored result for a repeated request id with the same arguments', async () => {
    const kitchenId = await freshKitchen();
    const first = testEvent(kitchenId, { requestId: 'same-1' });
    const appended = expectStatus(await store.append(appendInput(first, limits)), 'appended');

    const repeat = testEvent(kitchenId, { requestId: 'same-1' });
    expect(await store.append(appendInput(repeat, limits))).toEqual({
      status: 'duplicate',
      resultJson: appended.resultJson,
    });
    expect(await countEvents(kitchenId)).toBe(1);
  });

  it('returns reused for a repeated request id with different arguments and writes nothing', async () => {
    const kitchenId = await freshKitchen();
    await appendOne(kitchenId, { requestId: 'reused-1', argsHash: 'args-a' });

    const other = testEvent(kitchenId, { requestId: 'reused-1', argsHash: 'args-b', valueTenths: 450 });
    expect(await store.append(appendInput(other, limits))).toEqual({ status: 'reused' });
    expect(await countEvents(kitchenId)).toBe(1);
  });

  it('returns duplicate, never kitchen_closed, for a repeat inside the retry window after the write window closed', async () => {
    const kitchenId = await freshKitchen();
    const lateAt = KITCHEN_CREATED_AT + writeWindowMs(limits) - 30_000;
    const first = testEvent(kitchenId, { requestId: 'late-1', occurredAt: lateAt });
    const appended = expectStatus(await store.append(appendInput(first, limits)), 'appended');

    const repeatAt = KITCHEN_CREATED_AT + writeWindowMs(limits) + 30_000;
    const repeat = testEvent(kitchenId, { requestId: 'late-1', occurredAt: repeatAt });
    expect(await store.append(appendInput(repeat, limits))).toEqual({
      status: 'duplicate',
      resultJson: appended.resultJson,
    });
    expect(await countEvents(kitchenId)).toBe(1);
  });

  it('returns duplicate at exactly the retry window and expired one millisecond later, measured from the stored event', async () => {
    const kitchenId = await freshKitchen();
    const retryWindowMs = limits.retryWindowSeconds * 1000;
    const first = testEvent(kitchenId, { requestId: 'window-1' });
    const appended = expectStatus(await store.append(appendInput(first, limits)), 'appended');

    const atEdge = testEvent(kitchenId, { requestId: 'window-1', occurredAt: first.occurredAt + retryWindowMs });
    expect(await store.append(appendInput(atEdge, limits))).toEqual({
      status: 'duplicate',
      resultJson: appended.resultJson,
    });
    const pastEdge = testEvent(kitchenId, { requestId: 'window-1', occurredAt: first.occurredAt + retryWindowMs + 1 });
    expect(await store.append(appendInput(pastEdge, limits))).toEqual({
      status: 'expired',
      resultJson: appended.resultJson,
    });
    expect(await countEvents(kitchenId)).toBe(1);
  });

  interface ConcurrentRun {
    appended: Extract<AppendOutcome, { status: 'appended' }>[];
    appendedIds: string[];
    readIds: string[];
    readDayLines: number[];
  }

  // Promise.all keeps input order and says nothing about commit order, so order is only ever read
  // from the database's own seq, and the returned values are compared as sets.
  async function appendConcurrently(count: number): Promise<ConcurrentRun> {
    const kitchenId = await freshKitchen();
    const events = Array.from({ length: count }, () => testEvent(kitchenId));
    const outcomes = await Promise.all(events.map((event) => store.append(appendInput(event, limits))));
    const appended = outcomes.map((outcome) => expectStatus(outcome, 'appended'));
    const read = await d1.db
      .prepare('SELECT id, seq, day_line FROM events WHERE kitchen_id = ?1 ORDER BY seq')
      .bind(kitchenId)
      .all<{ id: string; seq: number; day_line: number }>();
    return {
      appended,
      appendedIds: events.map((event) => event.id),
      readIds: read.results.map((row) => row.id),
      readDayLines: read.results.map((row) => row.day_line),
    };
  }

  it('numbers two concurrent appends to one kitchen and day without collision', async () => {
    const run = await appendConcurrently(2);

    expect(new Set(run.appended.map((outcome) => outcome.seq)).size).toBe(2);
    expect(new Set(run.appended.map((outcome) => outcome.dayLine)).size).toBe(2);
    expect(run.readIds).toHaveLength(2);
    expect(new Set(run.readIds)).toEqual(new Set(run.appendedIds));
    expect(run.readDayLines).toEqual([1, 2]);
  });

  it('numbers four concurrent appends to one kitchen and day without collision, day lines running 1 to 4 in seq order', async () => {
    const run = await appendConcurrently(4);

    expect(new Set(run.appended.map((outcome) => outcome.seq)).size).toBe(4);
    expect(new Set(run.appended.map((outcome) => outcome.dayLine)).size).toBe(4);
    expect(run.readIds).toHaveLength(4);
    expect(new Set(run.readIds)).toEqual(new Set(run.appendedIds));
    expect(run.readDayLines).toEqual([1, 2, 3, 4]);
  });

  it('gives a held and a receipt event no day line and no record code, so the readings take lines 1 and 2', async () => {
    const kitchenId = await freshKitchen();
    const kinds: EventKind[] = ['reading', 'held', 'receipt', 'reading'];
    const outcomes = [];
    for (const kind of kinds) {
      outcomes.push(expectStatus(await store.append(appendInput(testEvent(kitchenId, { kind }), limits)), 'appended'));
    }

    expect(outcomes.map((outcome) => outcome.dayLine)).toEqual([1, null, null, 2]);
    const codes = outcomes.map((outcome) => JSON.parse(outcome.resultJson).structuredContent.recordCode);
    expect(codes).toEqual(['261020-001', undefined, undefined, '261020-002']);
    expect(outcomes[1].resultJson).toBe(RESULT_TEMPLATE);
  });

  it('answers a repeated receipt request id with the stored receipt, or reused when the arguments differ', async () => {
    const kitchenId = await freshKitchen();
    const receipt = testEvent(kitchenId, { kind: 'receipt', requestId: 'receipt-1', argsHash: 'args-r' });
    expectStatus(await store.append(appendInput(receipt, limits)), 'appended');

    const same = testEvent(kitchenId, { kind: 'receipt', requestId: 'receipt-1', argsHash: 'args-r' });
    expect(await store.append(appendInput(same, limits))).toEqual({ status: 'duplicate', resultJson: RESULT_TEMPLATE });
    const other = testEvent(kitchenId, { kind: 'receipt', requestId: 'receipt-1', argsHash: 'args-s' });
    expect(await store.append(appendInput(other, limits))).toEqual({ status: 'reused' });
    expect(await countEvents(kitchenId)).toBe(1);
  });

  it('refuses a write to the demo kitchen as kitchen_closed and writes nothing', async () => {
    const before = await countEvents('demo');

    const outcome = await store.append(appendInput(testEvent('demo'), limits));
    expect(outcome).toEqual({ status: 'refused', reason: 'kitchen_closed' });
    expect(await countEvents('demo')).toBe(before);
  });

  it('refuses a write past the daily row budget as budget_full and leaves the budget unchanged', async () => {
    const kitchenId = await freshKitchen();
    const utcDate = '2026-10-19';
    await d1.db
      .prepare('INSERT INTO budget (utc_date, rows) VALUES (?1, ?2)')
      .bind(utcDate, limits.dailyRowCap - 5)
      .run();

    const outcome = await store.append(appendInput(testEvent(kitchenId), limits, { utcDate, expectedRows: 10 }));
    expect(outcome).toEqual({ status: 'refused', reason: 'budget_full' });
    expect(await countEvents(kitchenId)).toBe(0);
    const budget = await d1.db.prepare('SELECT rows FROM budget WHERE utc_date = ?1').bind(utcDate).first<{ rows: number }>();
    expect(budget?.rows).toBe(limits.dailyRowCap - 5);
  });

  it('refuses the write after the kitchen line cap as kitchen_full', async () => {
    const kitchenId = await freshKitchen();
    for (let line = 0; line < limits.kitchenLineCap; line++) await appendOne(kitchenId);

    const outcome = await store.append(appendInput(testEvent(kitchenId), limits));
    expect(outcome).toEqual({ status: 'refused', reason: 'kitchen_full' });
    expect(await countEvents(kitchenId)).toBe(limits.kitchenLineCap);
  }, 60_000);

  // Reads are not budgeted, so a call refused at the cap must not walk the kitchen's lines: counting
  // them in the insert and again in the follow-up read cost 408 rows at the 200-line cap.
  it('reads a handful of rows for an append refused at the line cap, however many lines the kitchen holds', async () => {
    const kitchenId = await freshKitchen();
    await insertLines(d1.db, kitchenId, limits.kitchenLineCap, KITCHEN_CREATED_AT + 60_000);
    const counting = countingD1(d1.db);

    const outcome = await new D1Store(counting.db).append(appendInput(testEvent(kitchenId), limits));

    expect(outcome).toEqual({ status: 'refused', reason: 'kitchen_full' });
    expect(counting.totals().rowsRead).toBeLessThanOrEqual(HANDFUL_OF_ROWS);
  });

  it('keeps the kitchen line counter equal to the lines it holds, counting only the writes that landed', async () => {
    const kitchenId = await freshKitchen();
    const first = await appendOne(kitchenId, { requestId: 'counted-1' });
    await appendOne(kitchenId, { kind: 'receipt' });
    await store.append(appendInput(testEvent(kitchenId, { requestId: 'counted-1' }), limits));
    await store.append(appendInput(testEvent(kitchenId, { supersedesId: crypto.randomUUID() }), limits, { kitchenLineCap: 2 }));
    await appendOne(kitchenId, { supersedesId: first.id });

    const counter = await d1.db
      .prepare('SELECT lines FROM kitchen_lines WHERE kitchen_id = ?1')
      .bind(kitchenId)
      .first<{ lines: number }>();
    expect(counter?.lines).toBe(await countEvents(kitchenId));
    expect(counter?.lines).toBe(3);
  });

  // A database migrated before 0003 already holds lines, so the migration counts them as it creates
  // the table; a kitchen it missed would start again from zero under the cap.
  it('backfills the line counter of every kitchen from the lines it already holds when 0003 applies', { timeout: 20_000 }, async () => {
    const fresh = await openTestD1();
    try {
      const freshStore = new D1Store(fresh.db);
      const kitchens = [scratchKitchen(), scratchKitchen()];
      for (const kitchen of kitchens) await freshStore.createKitchen(kitchenInput(kitchen, limits));
      await insertLines(fresh.db, kitchens[0].id, 3, KITCHEN_CREATED_AT + 60_000);
      await insertLines(fresh.db, kitchens[1].id, 5, KITCHEN_CREATED_AT + 60_000);
      await fresh.db.prepare('DELETE FROM kitchen_lines').run();

      const backfill = migrationStatements('0003_kitchen_lines.sql').filter((sql) => /^\s*INSERT\b/i.test(sql));
      expect(backfill).toHaveLength(1);
      await fresh.db.prepare(backfill[0]).run();

      const counted = await fresh.db
        .prepare('SELECT kitchen_id, lines FROM kitchen_lines ORDER BY lines')
        .all<{ kitchen_id: string; lines: number }>();
      expect(counted.results).toEqual([
        { kitchen_id: kitchens[0].id, lines: 3 },
        { kitchen_id: kitchens[1].id, lines: 5 },
      ]);
    } finally {
      await fresh.dispose();
    }
  });

  it('rethrows a collision on the opaque event id as a server fault, never a conflict or a duplicate', async () => {
    const kitchenId = await freshKitchen();
    const first = await appendOne(kitchenId);

    const clash = testEvent(kitchenId, { id: first.id });
    await expect(store.append(appendInput(clash, limits))).rejects.toThrow(/UNIQUE constraint failed: events\.id/);
  });

  // An error naming no unique index is neither a repeat nor a conflict, so it leaves before any
  // follow-up read.
  it('rethrows a write the schema refuses, with no follow-up read and nothing written', async () => {
    const kitchenId = await freshKitchen();
    const counting = countingD1(d1.db);
    const celsius = testEvent(kitchenId, { unit: 'C' as unknown as NewEvent['unit'] });

    await expect(new D1Store(counting.db).append(appendInput(celsius, limits))).rejects.toThrow(/CHECK constraint failed/);
    expect(counting.statements.map((statement) => statement.via)).toEqual(['batch', 'batch', 'batch']);
    expect(await countEvents(kitchenId)).toBe(0);
  });

  it.each([
    ['a bare string', 'D1 went away'],
    ['an Error naming no unique index', new Error('D1_ERROR: Network connection lost.')],
  ])('rethrows %s from the batch unchanged, never reading it as a collision', async (_label, thrown) => {
    const failing: D1Like = {
      prepare: (query) => d1.db.prepare(query),
      batch: async () => {
        throw thrown;
      },
    };

    await expect(new D1Store(failing).append(appendInput(testEvent('demo'), limits))).rejects.toBe(thrown);
  });

  it('throws a named error, never a TypeError, when the follow-up read after a refused write finds no row', async () => {
    await expect(new D1Store(emptyD1()).append(appendInput(testEvent('demo'), limits))).rejects.toThrow(
      /^the append follow-up read returned no row$/,
    );
  });

  it('measures rows written per write kind equal to data/store/rows-per-write.json', async () => {
    const meter = new RowsMeter();
    const metered = new D1Store(meter.wrap(d1.db));
    const kitchen = scratchKitchen();
    const utcDate = '2027-01-01';
    const write = async (overrides: Partial<NewEvent>) => {
      expectStatus(await metered.append(appendInput(testEvent(kitchen.id, overrides), limits, { utcDate })), 'appended');
      return meter.rows;
    };

    // A mint as the first write of its UTC date: the kitchen row, its index rows and the budget row's
    // insert, the safe direction, as event_first_of_day is for events.
    const stored = readRowsPerWrite();
    const created = await metered.createKitchen(
      kitchenInput(kitchen, limits, { utcDate: '2026-12-31', expectedRows: stored.kitchen_create }),
    );
    expect(created).toEqual({ status: 'created' });
    const measured: Omit<RowsPerWrite, 'budget_add'> = {
      kitchen_create: meter.rows,
      event_first_of_day: await write({}),
      event: await write({}),
      event_superseding: await write({ supersedesId: crypto.randomUUID() }),
      event_answering: await write({ answersId: crypto.randomUUID() }),
    };
    console.log('measured rows written per write kind', JSON.stringify(measured));
    expect(measured).toEqual({
      kitchen_create: stored.kitchen_create,
      event_first_of_day: stored.event_first_of_day,
      event: stored.event,
      event_superseding: stored.event_superseding,
      event_answering: stored.event_answering,
    });
  });

  it('never writes more rows than expectedRowsFor reserves, for every event kind, index shape and budget-row state', async () => {
    const rowsPerWrite = readRowsPerWrite();
    const meter = new RowsMeter();
    const metered = new D1Store(meter.wrap(d1.db));
    const matrix: string[] = [];
    let dateIndex = 0;

    for (const kind of EVENT_KINDS) {
      for (const shape of INDEX_SHAPES) {
        for (const budgetRow of ['first of date', 'later'] as const) {
          dateIndex += 1;
          const month = String(1 + Math.floor((dateIndex - 1) / 28)).padStart(2, '0');
          const utcDate = `2028-${month}-${String(((dateIndex - 1) % 28) + 1).padStart(2, '0')}`;
          const kitchenId = await freshKitchen();
          if (budgetRow === 'later') {
            expectStatus(await store.append(appendInput(testEvent(kitchenId), limits, { utcDate })), 'appended');
          }
          const event = testEvent(kitchenId, {
            kind,
            supersedesId: shape === 'supersedes' || shape === 'both' ? crypto.randomUUID() : null,
            answersId: shape === 'answers' || shape === 'both' ? crypto.randomUUID() : null,
          });
          const reserve = expectedRowsFor(event, rowsPerWrite);
          expectStatus(await metered.append(appendInput(event, limits, { utcDate, expectedRows: reserve })), 'appended');
          matrix.push(`${kind} / ${shape} / ${budgetRow}: measured ${meter.rows}, reserved ${reserve}`);
          expect(meter.rows, matrix[matrix.length - 1]).toBeLessThanOrEqual(reserve);
        }
      }
    }
    console.log(`rows written matrix\n${matrix.join('\n')}`);
    expect(matrix).toHaveLength(EVENT_KINDS.length * INDEX_SHAPES.length * 2);
  }, 120_000);
});

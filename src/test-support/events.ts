import { readFileSync } from 'node:fs';
import type { AppendInput, CreateKitchenInput, D1Like, KitchenRow, NewEvent, RowsPerWrite } from '../store/port';

export interface StoreLimits {
  dailyRowCap: number;
  kitchenLineCap: number;
  writeWindowHours: number;
  retentionAgeHours: number;
  retryWindowSeconds: number;
  sweepBatchLimit: number;
  cronSweepBatchLimit: number;
  maxSweepRounds: number;
}

// One statement per seed, not one per row: a batch of hundreds of single inserts through the local
// proxy takes seconds.
const INSERT_SCRATCH_KITCHENS = `
INSERT INTO kitchens (id, kind, label, time_zone, day_start, created_at)
SELECT json_extract(value, '$[0]'), 'scratch', NULL, 'America/Chicago', '04:00', json_extract(value, '$[1]')
FROM json_each(?1)`;

// Receipts take no day line, so any number of seeded lines can share one business day.
const INSERT_SEEDED_LINES = `
WITH RECURSIVE line(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM line WHERE n < ?3)
INSERT INTO events (
  id, kitchen_id, kind, occurred_at, business_day, time_zone, screen_id, request_id, origin, words,
  outcome, result_json, args_hash
)
SELECT lower(hex(randomblob(16))), ?1, 'receipt', ?2, ?4, 'America/Chicago', 'seed',
  lower(hex(randomblob(16))), 'seed', 'seeded line', 'receipt', '{}', 'seed'
FROM line`;

// Seeded lines count against the line cap exactly as appended ones do.
const COUNT_SEEDED_LINES = `
INSERT INTO kitchen_lines (kitchen_id, lines) VALUES (?1, ?2)
ON CONFLICT (kitchen_id) DO UPDATE SET lines = lines + excluded.lines`;

export const HOUR_MS = 3_600_000;
export const KITCHEN_CREATED_AT = Date.UTC(2026, 9, 20, 14, 0, 0);
const BUSINESS_DAY = '2026-10-20';
const UTC_DATE = '2026-10-20';

export const RESULT_TEMPLATE = JSON.stringify({
  content: [{ type: 'text', text: 'Logged the walk-in at 38 degrees.' }],
  structuredContent: { outcome: 'logged' },
});

export function readLimits(): StoreLimits {
  return JSON.parse(readFileSync('data/store/limits.json', 'utf8')) as StoreLimits;
}

export function readRowsPerWrite(): RowsPerWrite {
  return JSON.parse(readFileSync('data/store/rows-per-write.json', 'utf8')) as RowsPerWrite;
}

export function scratchKitchen(createdAt = KITCHEN_CREATED_AT): KitchenRow {
  return {
    id: crypto.randomUUID(),
    kind: 'scratch',
    label: null,
    timeZone: 'America/Chicago',
    dayStart: '04:00',
    createdAt,
  };
}

export function testEvent(kitchenId: string, overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    id: crypto.randomUUID(),
    kitchenId,
    kind: 'reading',
    occurredAt: KITCHEN_CREATED_AT + 60_000,
    businessDay: BUSINESS_DAY,
    timeZone: 'America/Chicago',
    screenId: 'wall',
    requestId: crypto.randomUUID(),
    origin: 'person',
    checkPointId: 'walk_in',
    measured: 'air',
    initials: 'QX',
    words: 'the walk-in reads 38',
    valueTenths: 380,
    unit: 'F',
    outcome: 'logged',
    verdict: 'pass',
    ruleId: 'cold_holding',
    ruleSnapshot: null,
    rulesVersion: 'test',
    supersedesId: null,
    rootId: null,
    refId: null,
    answersId: null,
    promptKind: null,
    expiresAt: null,
    dueSlotId: null,
    dueAt: null,
    argsHash: 'args-a',
    ...overrides,
  };
}

export function kitchenInput(
  kitchen: KitchenRow,
  limits: StoreLimits,
  overrides: Partial<CreateKitchenInput> = {},
): CreateKitchenInput {
  return { kitchen, expectedRows: 20, utcDate: UTC_DATE, dailyRowCap: limits.dailyRowCap, ...overrides };
}

// Kitchens written straight into the table, for retention tests that need them at a chosen age.
export async function insertScratchKitchens(db: D1Like, createdAts: number[]): Promise<string[]> {
  const ids = createdAts.map(() => crypto.randomUUID().replaceAll('-', ''));
  if (ids.length > 0) {
    const rows = JSON.stringify(ids.map((id, index) => [id, createdAts[index]]));
    await db.prepare(INSERT_SCRATCH_KITCHENS).bind(rows).run();
  }
  return ids;
}

export async function insertLines(
  db: D1Like,
  kitchenId: string,
  count: number,
  occurredAt: number,
  businessDay = BUSINESS_DAY,
): Promise<void> {
  if (count === 0) return;
  await db.batch([
    db.prepare(INSERT_SEEDED_LINES).bind(kitchenId, occurredAt, count, businessDay),
    db.prepare(COUNT_SEEDED_LINES).bind(kitchenId, count),
  ]);
}

export function appendInput(
  event: NewEvent,
  limits: StoreLimits,
  overrides: Partial<AppendInput> = {},
): AppendInput {
  return {
    event,
    resultTemplate: RESULT_TEMPLATE,
    expectedRows: 20,
    utcDate: UTC_DATE,
    dailyRowCap: limits.dailyRowCap,
    kitchenLineCap: limits.kitchenLineCap,
    writeWindowMs: limits.writeWindowHours * HOUR_MS,
    retryWindowMs: limits.retryWindowSeconds * 1000,
    now: event.occurredAt,
    ...overrides,
  };
}

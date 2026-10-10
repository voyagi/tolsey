import { ROWS_PER_WRITE, STORE_LIMITS, type StoreLimits } from '../server/data';
import { writeWindowMs } from '../server/kitchens';
import type { AppendInput, CreateKitchenInput, D1Like, KitchenRow, NewEvent, RowsPerWrite } from '../store/port';

export type { StoreLimits };

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

// Whole events written in one statement, in array order, so seq follows the array. They take no day
// line, which no read under test needs, and the line counter is raised by the same number.
const INSERT_SEEDED_EVENTS = `
INSERT INTO events (
  id, kitchen_id, kind, occurred_at, business_day, time_zone, screen_id, request_id, origin,
  check_point_id, measured, initials, words, value_tenths, unit, outcome, verdict, rule_id,
  rule_snapshot, rules_version, supersedes_id, root_id, ref_id, answers_id, prompt_kind, expires_at,
  result_json, args_hash
)
SELECT
  json_extract(value, '$.id'), json_extract(value, '$.kitchenId'), json_extract(value, '$.kind'),
  json_extract(value, '$.occurredAt'), json_extract(value, '$.businessDay'), json_extract(value, '$.timeZone'),
  json_extract(value, '$.screenId'), json_extract(value, '$.requestId'), json_extract(value, '$.origin'),
  json_extract(value, '$.checkPointId'), json_extract(value, '$.measured'), json_extract(value, '$.initials'),
  json_extract(value, '$.words'), json_extract(value, '$.valueTenths'), json_extract(value, '$.unit'),
  json_extract(value, '$.outcome'), json_extract(value, '$.verdict'), json_extract(value, '$.ruleId'),
  json_extract(value, '$.ruleSnapshot'), json_extract(value, '$.rulesVersion'), json_extract(value, '$.supersedesId'),
  json_extract(value, '$.rootId'), json_extract(value, '$.refId'), json_extract(value, '$.answersId'),
  json_extract(value, '$.promptKind'), json_extract(value, '$.expiresAt'), '{}', json_extract(value, '$.argsHash')
FROM json_each(?1)`;

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

// The Worker's own validated copies, so a test can never run against a limit the Worker would refuse.
export function readLimits(): StoreLimits {
  return { ...STORE_LIMITS };
}

export function readRowsPerWrite(): RowsPerWrite {
  return { ...ROWS_PER_WRITE };
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

// Events of any shape straight into the table, for read tests that need a kitchen of a chosen shape
// without one append per event.
export async function insertEvents(db: D1Like, events: NewEvent[]): Promise<void> {
  if (events.length === 0) return;
  const kitchenId = events[0].kitchenId;
  if (events.some((event) => event.kitchenId !== kitchenId)) throw new Error('insertEvents seeds one kitchen at a time');
  await db.batch([
    db.prepare(INSERT_SEEDED_EVENTS).bind(JSON.stringify(events)),
    db.prepare(COUNT_SEEDED_LINES).bind(kitchenId, events.length),
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
    writeWindowMs: writeWindowMs(limits),
    retryWindowMs: limits.retryWindowSeconds * 1000,
    now: event.occurredAt,
    ...overrides,
  };
}

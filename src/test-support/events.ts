import { readFileSync } from 'node:fs';
import type { AppendInput, KitchenRow, NewEvent, RowsPerWrite } from '../store/port';

export interface StoreLimits {
  dailyRowCap: number;
  kitchenLineCap: number;
  writeWindowHours: number;
  retentionAgeHours: number;
  retryWindowSeconds: number;
}

export const HOUR_MS = 3_600_000;
export const KITCHEN_CREATED_AT = Date.UTC(2026, 9, 20, 14, 0, 0);
export const BUSINESS_DAY = '2026-10-20';
export const UTC_DATE = '2026-10-20';

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

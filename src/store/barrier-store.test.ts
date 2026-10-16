import { describe, expect, it } from 'vitest';
import { barrierStore } from '../test-support/barrier-store';
import { MemoryStore } from './memory-store';
import type { AppendInput, NewEvent } from './port';

const NOW = Date.parse('2026-10-20T19:00:00Z');
const KITCHEN = { id: 'barrier', kind: 'scratch' as const, label: null, timeZone: 'America/Chicago', dayStart: '04:00', createdAt: NOW };

function heldCall(id: string): AppendInput {
  const event: NewEvent = {
    id,
    kitchenId: KITCHEN.id,
    kind: 'held',
    occurredAt: NOW,
    businessDay: '2026-10-20',
    timeZone: KITCHEN.timeZone,
    screenId: 'barrier-wall',
    requestId: id,
    origin: 'person',
    checkPointId: 'walk_in',
    measured: 'air',
    initials: 'AB',
    words: 'walk-in 38',
    valueTenths: 380,
    unit: 'F',
    outcome: 'held',
    verdict: null,
    ruleId: null,
    ruleSnapshot: null,
    rulesVersion: 'v1',
    supersedesId: null,
    rootId: null,
    refId: null,
    answersId: null,
    promptKind: 'who_is_logging',
    expiresAt: NOW + 120_000,
    dueSlotId: null,
    dueAt: null,
    argsHash: 'hash',
  };
  return {
    event,
    resultTemplate: '{"structuredContent":{}}',
    expectedRows: 1,
    utcDate: '2026-10-21',
    dailyRowCap: 1000,
    kitchenLineCap: 200,
    writeWindowMs: 3_600_000,
    retryWindowMs: 120_000,
    now: NOW,
  };
}

// The race tests wrap a store in barrierStore and still write through the store itself. A wrapper
// that inherited from the store ran its methods with the wrapper as `this`, so MemoryStore's counter
// was written onto the wrapper and the next append on the store reused seq 1.
describe('barrierStore', () => {
  it('keeps one seq across appends made through the wrapper and on the memory store it wraps', async () => {
    const inner = new MemoryStore();
    await inner.createKitchen({ kitchen: KITCHEN, expectedRows: 1, utcDate: '2026-10-21', dailyRowCap: 1000 });

    const throughWrapper = await barrierStore(inner, 2).append(heldCall('first'));
    const direct = await inner.append(heldCall('second'));

    expect([throughWrapper, direct].map((outcome) => (outcome.status === 'appended' ? outcome.seq : outcome.status))).toEqual([1, 2]);
  });
});

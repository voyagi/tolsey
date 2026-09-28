import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StoredLine } from '../store/port';
import { callLogReading, type ToolResult } from '../test-support/mcp-client';
import { mintThroughRoute, openInProcessWorker, type InProcessWorker } from '../test-support/target';

const AFTERNOON = Date.parse('2026-10-20T19:00:00Z');
const DAY = '2026-10-20';

describe('a check given without a number, through MCP', () => {
  let worker: InProcessWorker;

  beforeAll(async () => {
    worker = await openInProcessWorker();
    worker.clock.set(AFTERNOON);
  });

  afterAll(async () => {
    await worker?.dispose();
  });

  async function kitchen(): Promise<string> {
    return (await mintThroughRoute(worker.fetch, worker.baseUrl)).id;
  }

  function call(kitchenId: string, args: Record<string, unknown>): Promise<ToolResult> {
    return callLogReading(worker.fetch, new URL(`/mcp/k/${kitchenId}`, worker.baseUrl), {
      screen_id: 'refusal-wall',
      request_id: crypto.randomUUID(),
      ...args,
    });
  }

  async function lines(kitchenId: string): Promise<StoredLine[]> {
    return worker.store.linesForDay(kitchenId, DAY);
  }

  function ofKind(stored: StoredLine[], kind: StoredLine['kind']): StoredLine[] {
    return stored.filter((line) => line.kind === kind);
  }

  it('refuses "the reach-in is fine" as a normal result naming the number needed, with no value or unit (E4)', async () => {
    const kitchenId = await kitchen();
    const result = await call(kitchenId, { check_point: 'reach_in_1', words: 'the reach-in is fine', initials: 'AB' });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'I need the number on the thermometer. What does reach-in one read?',
    });
    const structured = result.structuredContent ?? {};
    expect(structured.outcome).toBe('refused');
    expect(structured).not.toHaveProperty('value');
    expect(structured).not.toHaveProperty('unit');
    expect(structured.prompt).toEqual({ kind: 'number', id: structured.lineId });

    const stored = await lines(kitchenId);
    expect(ofKind(stored, 'refusal')).toHaveLength(1);
    expect(ofKind(stored, 'refusal')[0]).toMatchObject({
      words: 'the reach-in is fine',
      checkPointId: 'reach_in_1',
      valueTenths: null,
      verdict: null,
      promptKind: 'number',
    });
    expect(ofKind(stored, 'reading')).toHaveLength(0);
  });

  it('keeps the refused check open until a numeric reading closes it, and still counts the refusal line (E23)', async () => {
    const kitchenId = await kitchen();
    await call(kitchenId, { check_point: 'reach_in_1', words: 'the reach-in is fine', initials: 'AB' });

    expect(await worker.store.openChecks(kitchenId, DAY)).toEqual(['reach_in_1']);

    const retake = await call(kitchenId, { check_point: 'reach_in_1', value: 38, initials: 'AB' });
    expect(retake.structuredContent?.outcome).toBe('in_range');
    expect(await worker.store.openChecks(kitchenId, DAY)).toEqual([]);
    expect(ofKind(await lines(kitchenId), 'refusal')).toHaveLength(1);
  });

  it('refuses "everything is fine" with no check point as one refusal line that asks nothing and opens no check', async () => {
    const kitchenId = await kitchen();
    await call(kitchenId, { check_point: 'walk_in', words: 'the walk-in is fine', initials: 'AB' });
    const openBefore = await worker.store.openChecks(kitchenId, DAY);

    const result = await call(kitchenId, { words: 'everything is fine', initials: 'AB' });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toBe('I need a check and the number on the thermometer.');
    expect(result.structuredContent?.outcome).toBe('refused');
    expect(result.structuredContent).not.toHaveProperty('prompt');
    const refusals = ofKind(await lines(kitchenId), 'refusal');
    expect(refusals).toHaveLength(2);
    expect(refusals[1]).toMatchObject({ checkPointId: null, promptKind: null, expiresAt: null });
    expect(await worker.store.openChecks(kitchenId, DAY)).toEqual(openBefore);
  });
});

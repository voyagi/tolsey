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

  // The digit in the check point's own name is not a number the cook said (E4).
  it('refuses "the reach-in 2 is fine" with a value attached, and never stores that value', async () => {
    const kitchenId = await kitchen();
    const result = await call(kitchenId, { check_point: 'reach_in_2', value: 38, words: 'the reach-in 2 is fine', initials: 'AB' });

    expect(result.structuredContent?.outcome).toBe('refused');
    expect(ofKind(await lines(kitchenId), 'reading')).toHaveLength(0);
    expect(await worker.store.openChecks(kitchenId, DAY)).toEqual(['reach_in_2']);
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

  describe('a number given as a limit, a range or a guess', () => {
    it('refuses value 41 said as "the walk-in is under 41" and never stores 41', async () => {
      const kitchenId = await kitchen();
      const result = await call(kitchenId, {
        check_point: 'walk_in',
        value: 41,
        words: 'the walk-in is under 41',
        initials: 'AB',
      });

      expect(result.isError).not.toBe(true);
      expect(result.content[0]?.text).toBe('I need the number on the thermometer. What does the walk-in read?');
      expect(result.structuredContent?.outcome).toBe('refused');
      expect(result.structuredContent).not.toHaveProperty('value');
      const stored = await lines(kitchenId);
      expect(stored.filter((line) => line.valueTenths === 410)).toHaveLength(0);
      expect(ofKind(stored, 'reading')).toHaveLength(0);
      expect(ofKind(stored, 'refusal')[0]?.words).toBe('the walk-in is under 41');
      expect(await worker.store.openChecks(kitchenId, DAY)).toEqual(['walk_in']);
    });

    it.each([
      ['38 or 39', 38],
      ['about 40', 40],
      ['below 5', 5],
      ['at most 41', 41],
      ['38-40', 39],
      ['the walk-in is 38, below 41', 38],
      ['2 below the limit', 2],
      ['38\u201340', 39],
      ['38 through 40', 39],
    ])('refuses "%s" even with a value attached (E22)', async (words, value) => {
      const kitchenId = await kitchen();
      const result = await call(kitchenId, { check_point: 'walk_in', value, words, initials: 'AB' });

      expect(result.structuredContent?.outcome).toBe('refused');
      expect(ofKind(await lines(kitchenId), 'reading')).toHaveLength(0);
    });

    // The host heard 39 where the cook said 38: neither number is stored, and the words stay as said.
    it('refuses value 39 beside "the walk-in reads 38", stores neither number as a reading and keeps the check open', async () => {
      const kitchenId = await kitchen();
      const result = await call(kitchenId, { check_point: 'walk_in', value: 39, words: 'the walk-in reads 38', initials: 'AB' });

      expect(result.isError).not.toBe(true);
      expect(result.content[0]?.text).toBe('I need the number on the thermometer. What does the walk-in read?');
      expect(result.structuredContent).toMatchObject({ outcome: 'refused', prompt: { kind: 'number' } });
      expect(result.structuredContent).not.toHaveProperty('value');
      const stored = await lines(kitchenId);
      expect(ofKind(stored, 'reading')).toHaveLength(0);
      expect(stored.filter((line) => line.valueTenths !== null)).toHaveLength(0);
      expect(ofKind(stored, 'refusal')[0]?.words).toBe('the walk-in reads 38');
      expect(await worker.store.openChecks(kitchenId, DAY)).toEqual(['walk_in']);
    });

    // Judged at the soup well, a walk-in 38 would fail hot holding: the call is refused instead.
    it('refuses "walk-in reads 38" sent with the soup well, judges nothing and asks about the soup well', async () => {
      const kitchenId = await kitchen();
      const result = await call(kitchenId, { check_point: 'soup_well', value: 38, words: 'walk-in reads 38', initials: 'AB' });

      expect(result.isError).not.toBe(true);
      expect(result.content[0]?.text).toBe('I need the number on the thermometer. What does the soup well read?');
      expect(result.structuredContent).toMatchObject({ outcome: 'refused', prompt: { kind: 'number' } });
      expect(result.structuredContent).not.toHaveProperty('rule');
      const stored = await lines(kitchenId);
      expect(ofKind(stored, 'reading')).toHaveLength(0);
      expect(stored.filter((line) => line.valueTenths !== null || line.verdict !== null)).toHaveLength(0);
    });

    // The 130s straddle the hot-holding limit of 135, so a decade must never pass as a hot reading.
    it('refuses value 135 at the soup well said as "in the 130s" and asks for the number', async () => {
      const kitchenId = await kitchen();
      const result = await call(kitchenId, { check_point: 'soup_well', value: 135, words: 'in the 130s', initials: 'AB' });

      expect(result.structuredContent).toMatchObject({ outcome: 'refused', prompt: { kind: 'number' } });
      expect(ofKind(await lines(kitchenId), 'reading')).toHaveLength(0);
    });
  });

  describe('a reading below zero (E21)', () => {
    it.each([
      [-5, '5 below'],
      [5, '5 below zero'],
      [5, 'the freezer reads minus 5'],
      [5, 'negative 5'],
      [5, 'the freezer reads minus five'],
      [5, "it's 5 degrees below zero"],
      [-5, 'the freezer'],
    ])('logs value %d said as "%s" at the freezer as -5, judged in range by the freezer limit', async (value, words) => {
      const kitchenId = await kitchen();
      const result = await call(kitchenId, { check_point: 'freezer', value, words, initials: 'AB' });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ outcome: 'in_range', value: -5, rule: { id: 'freezer_limit' } });
      expect(ofKind(await lines(kitchenId), 'reading')[0]?.valueTenths).toBe(-50);
    });

    // The cook said 5, which fails the freezer: a host's minus beside a figure said with no sign must
    // never turn it into a pass, nor rewrite the words to match (N1).
    it.each([
      [-5, 'the freezer reads 5'],
      [-5, 'the freezer reads five'],
    ])('refuses value %d beside "%s", a figure said with no sign', async (value, words) => {
      const kitchenId = await kitchen();
      const result = await call(kitchenId, { check_point: 'freezer', value, words, initials: 'AB' });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ outcome: 'refused', prompt: { kind: 'number' } });
      const stored = await lines(kitchenId);
      expect(ofKind(stored, 'reading')).toHaveLength(0);
      expect(ofKind(stored, 'held')).toHaveLength(0);
      expect(ofKind(stored, 'refusal')).toHaveLength(1);
    });

    it('keeps the words of a figure said with no sign as said on the refused line', async () => {
      const kitchenId = await kitchen();
      await call(kitchenId, { check_point: 'freezer', value: -5, words: 'the freezer reads 5', initials: 'AB' });

      expect(ofKind(await lines(kitchenId), 'refusal')[0]?.words).toBe('the freezer reads 5');
    });

    // The contract refuses a value below absolute zero, and a sign word must not carry one past it.
    it.each([
      [500, 'minus 500'],
      [500, '500 below'],
    ])('refuses value %d said as "%s", which would put the reading below absolute zero', async (value, words) => {
      const kitchenId = await kitchen();
      const result = await call(kitchenId, { check_point: 'freezer', value, words, initials: 'AB' });

      expect(result.structuredContent?.outcome).toBe('refused');
      expect(ofKind(await lines(kitchenId), 'reading')).toHaveLength(0);
      expect(ofKind(await lines(kitchenId), 'held')).toHaveLength(0);
    });

    // A walk-in at -5 is below its coarse band, so it is held for a digit repeat. The repeat is
    // confirmed by the number its words give, so "5 below" beside the value 5 repeats -5.
    it('logs a held walk-in -5 when the repeat says "5 below" beside the value 5', async () => {
      const kitchenId = await kitchen();
      const held = await call(kitchenId, { check_point: 'walk_in', value: 5, words: '5 below', initials: 'AB' });
      const prompt = held.structuredContent?.prompt as { kind: string; id: string };
      expect(prompt.kind).toBe('digit_repeat');

      const repeated = await call(kitchenId, { value: 5, words: '5 below', pending_prompt_id: prompt.id });

      expect(repeated.structuredContent).toMatchObject({ outcome: 'in_range', value: -5 });
      expect(ofKind(await lines(kitchenId), 'reading')).toEqual([
        expect.objectContaining({ valueTenths: -50, answersId: prompt.id }),
      ]);
    });
  });

  it('keeps a cooling reading whose words name "the cool down" in words, never refusing it as a state', async () => {
    const kitchenId = await kitchen();
    const result = await call(kitchenId, { check_point: 'cooling', value: 40, words: 'the cool down reads forty', initials: 'AB' });

    expect(result.structuredContent).toMatchObject({ outcome: 'not_covered', value: 40 });
  });

  it('stores at most two short figures from the words of a refused line', async () => {
    const kitchenId = await kitchen();
    await call(kitchenId, { check_point: 'walk_in', words: 'call 555 123 4567', initials: 'AB' });

    expect(ofKind(await lines(kitchenId), 'refusal')[0]?.words).toBe('555 123');
  });

  describe('a number that may be a misheard teen or ten', () => {
    it.each([15, 13])('holds walk-in %d for a digit-by-digit repeat, judges nothing and keeps the check open', async (value) => {
      const kitchenId = await kitchen();
      const result = await call(kitchenId, {
        check_point: 'walk_in',
        value,
        words: `the walk-in reads ${value}`,
        initials: 'AB',
      });

      expect(result.isError).not.toBe(true);
      expect(result.content[0]?.text).toBe('Say it one digit at a time. What does the walk-in read?');
      const structured = result.structuredContent ?? {};
      expect(structured.outcome).toBe('held');
      expect(structured).not.toHaveProperty('rule');
      expect(structured).not.toHaveProperty('lineId');
      expect(structured.prompt).toMatchObject({ kind: 'digit_repeat' });
      const stored = await lines(kitchenId);
      expect(ofKind(stored, 'reading')).toHaveLength(0);
      expect(ofKind(stored, 'held')).toEqual([
        expect.objectContaining({ valueTenths: value * 10, promptKind: 'digit_repeat', verdict: null, dayLine: null }),
      ]);
      expect(await worker.store.openChecks(kitchenId, DAY)).toEqual(['walk_in']);
    });

    // The repeat asks for one digit at a time, so its words spell the number digit by digit.
    it('logs a held walk-in 15 when the repeat says it one digit at a time, "1 5"', async () => {
      const kitchenId = await kitchen();
      const held = await call(kitchenId, { check_point: 'walk_in', value: 15, words: 'the walk-in reads 15', initials: 'AB' });
      const prompt = held.structuredContent?.prompt as { kind: string; id: string };
      expect(prompt.kind).toBe('digit_repeat');

      const repeated = await call(kitchenId, { value: 15, words: '1 5', pending_prompt_id: prompt.id });

      expect(repeated.structuredContent).toMatchObject({ outcome: 'in_range', value: 15 });
      expect(ofKind(await lines(kitchenId), 'reading')).toEqual([expect.objectContaining({ valueTenths: 150, answersId: prompt.id })]);
    });
  });
});

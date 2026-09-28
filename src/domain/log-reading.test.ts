import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import demoJson from '../../data/kitchens/demo.json';
import rulesJson from '../../data/rules/food-code-2022.json';
import { LogReadingInputSchema, LogReadingOutputSchema, type LogReadingInput } from '../contract/log-reading';
import { kitchenSettings } from './business-day';
import { decideLogReading, type DecisionContext } from './log-reading';
import { KitchenProfileSchema, RuleTableSchema } from './rule';

const table = RuleTableSchema.parse(rulesJson);
const profile = KitchenProfileSchema.parse(demoJson);

// 23:30 CDT on 2026-10-20, already 2026-10-21 in UTC.
const CALL_AT = Date.UTC(2026, 9, 21, 4, 30);

const ctx: DecisionContext = {
  now: CALL_AT,
  newId: () => 'line-1',
  kitchen: { id: 'kitchen-1', timeZone: 'America/Chicago', dayStart: '04:00' },
  rules: new Map(table.rows.map((row) => [row.id, row])),
  rulesVersion: table.rulesVersion,
  profile,
};

function walkIn(overrides: Partial<LogReadingInput> = {}): LogReadingInput {
  return {
    check_point: 'walk_in',
    value: 38,
    measured: 'air',
    words: 'the walk-in reads 38',
    initials: 'AB',
    screen_id: 'wall',
    request_id: 'request-1',
    ...overrides,
  };
}

function decided(input: LogReadingInput) {
  const decision = decideLogReading(input, ctx);
  if (decision.status !== 'decided') throw new Error(`expected a decided reading, got ${decision.code}`);
  return decision;
}

function spokenPair(input: LogReadingInput) {
  const { result } = decided(input);
  return { text: result.content[0].text, structuredContent: result.structuredContent };
}

describe('the read-back and the structured result', () => {
  it('pins the in_range pair for walk-in 38', () => {
    expect(spokenPair(walkIn())).toMatchSnapshot();
  });

  it('pins the out_of_range pair for walk-in 45', () => {
    expect(spokenPair(walkIn({ value: 45, words: 'the walk-in reads 45' }))).toMatchSnapshot();
  });

  it.each([38, 45])('speaks walk-in %d with no markdown, no degree sign and never the word fine', (value) => {
    const { text } = spokenPair(walkIn({ value }));
    expect(text).not.toMatch(/[*_`#>|°]/);
    expect(text).not.toMatch(/\bfine\b/i);
  });

  it('keeps an in-range reply to eight words with the number in the first three', () => {
    const words = spokenPair(walkIn()).text.split(/\s+/);
    expect(words.length).toBeLessThanOrEqual(8);
    expect(words.slice(0, 3).map((word) => word.replace(/,$/, ''))).toContain('38');
  });
});

describe('the rule a reading is judged against', () => {
  it('judges the walk-in air by the house rule, with limit 41 and no Code section', () => {
    const { rule } = spokenPair(walkIn()).structuredContent;
    expect(rule).toEqual({ id: 'unit_air_cold', comparator: 'at_most', limit: 41, unit: 'F', sourceKind: 'house_rule' });
  });

  it('judges a food probed in the walk-in by cold holding, citing 3-501.16(A)(2)', () => {
    const { rule } = spokenPair(walkIn({ measured: 'chicken_soup' })).structuredContent;
    expect(rule).toMatchObject({ id: 'cold_holding', section: '3-501.16(A)(2)', sourceKind: 'food_code' });
  });
});

describe('the words stored with a reading', () => {
  it('rebuilds absent words from the check point and the number', () => {
    expect(decided(walkIn({ words: undefined })).event.words).toBe('walk-in 38');
  });

  it('keeps only recognised tokens, so no markup or other text persists', () => {
    const { event } = decided(walkIn({ words: '<b>the walk-in</b> reads 38 ünïcode' }));
    expect(event.words).toBe('the walk-in reads 38');
  });

  it('writes the number the way the value is stored when the words spell it another way', () => {
    expect(decided(walkIn({ words: 'the walk-in reads 38.0' })).event.words).toBe('the walk-in reads 38');
  });

  it.each([
    ['a spoken negative', { check_point: 'freezer', value: -5, words: 'freezer reads minus five' }, 'freezer -5'],
    ['a number said in words', { value: 38, words: 'the walk-in reads thirty eight' }, 'walk-in 38'],
    ['a half said in words', { value: 38.5, words: 'the walk-in reads 38 and a half' }, 'walk-in 38.5'],
  ] as const)('never stores words without the number: %s falls back to the check point and value', (_label, overrides, words) => {
    expect(decided(walkIn({ measured: undefined, ...overrides })).event.words).toBe(words);
  });
});

describe('the number judged and the number read back', () => {
  // The walk-in air limit, 41 or less, in tenths.
  const WALK_IN_AIR_LIMIT_TENTHS = 410;
  // The demo cold coarse band, 20 to 60, and the walk-in readings whose ten twin would fail 41.
  const COLD_BAND_TENTHS = { low: 200, high: 600 };
  const WALK_IN_TWIN_TENTHS = new Set([150, 160, 170, 180, 190]);

  function expectedOutcome(tenths: number): string {
    if (tenths < COLD_BAND_TENTHS.low || tenths > COLD_BAND_TENTHS.high || WALK_IN_TWIN_TENTHS.has(tenths)) return 'held';
    return tenths <= WALK_IN_AIR_LIMIT_TENTHS ? 'in_range' : 'out_of_range';
  }

  it('stores and reads back exactly the number given, judging it or holding it for a repeat, for every tenth the contract accepts', () => {
    fc.assert(
      fc.property(fc.integer({ min: -4596, max: 10000 }), (tenths) => {
        const input = LogReadingInputSchema.parse(walkIn({ value: tenths / 10, words: undefined }));
        const { event, result } = decided(input);
        const outcome = expectedOutcome(tenths);
        expect(event.valueTenths).toBe(tenths);
        expect(result.structuredContent.value).toBe(input.value);
        expect(result.structuredContent.outcome).toBe(outcome);
        const stored = outcome === 'held' ? result.structuredContent : { ...result.structuredContent, recordCode: '261020-001' };
        expect(LogReadingOutputSchema.safeParse(stored).success).toBe(true);
      }),
    );
  });
});

describe('kitchenSettings', () => {
  it('fills the America/Chicago zone and the 04:00 day start when none is given', () => {
    expect(kitchenSettings({})).toEqual({ timeZone: 'America/Chicago', dayStart: '04:00' });
  });

  it('keeps a given day start beside the default zone', () => {
    expect(kitchenSettings({ dayStart: '05:00' })).toEqual({ timeZone: 'America/Chicago', dayStart: '05:00' });
  });
});

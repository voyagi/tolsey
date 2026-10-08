import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import demoJson from '../../data/kitchens/demo.json';
import rulesJson from '../../data/rules/food-code-2022.json';
import { LogReadingInputSchema, LogReadingOutputSchema, type LogReadingInput } from '../contract/log-reading';
import { kitchenSettings } from './business-day';
import { alreadyAnswered, decideLogReading, spokenReadback, type DecisionContext } from './log-reading';
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

describe('spokenReadback', () => {
  it('speaks only the parts a result carries', () => {
    const { structuredContent } = spokenPair(walkIn());
    const { checkPoint: _checkPoint, initials: _initials, ...unnamed } = structuredContent;
    const { value: _value, ...valueless } = structuredContent;
    expect(spokenReadback(unnamed)).toBe('38, in range');
    expect(spokenReadback(valueless)).toBe('Walk-in, in range, AB');
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

describe('the sign the words give a value', () => {
  it('stores a zero said with a sign word as zero, never as negative zero', () => {
    const { event, result } = decided(walkIn({ check_point: 'freezer', value: 0, words: 'the freezer reads minus zero' }));
    expect(event.valueTenths).toBe(0);
    expect(result.structuredContent.value).toBe(0);
  });

  it('refuses a value beside sign words that name another figure', () => {
    const { result } = decided(walkIn({ check_point: 'freezer', value: 7, words: 'the freezer reads 5 below' }));
    expect(result.structuredContent.outcome).toBe('refused');
  });

  // Zero is no exception: the words name a figure below zero, so a 0 beside them is a number the
  // cook did not say, and storing it would put a reading in the record that nobody read.
  it.each(['the freezer reads 5 below', 'the freezer reads minus 5', 'the freezer reads -5'])(
    'refuses the value 0 beside "%s", whose figure is not the value',
    (words) => {
      const { event, result } = decided(walkIn({ check_point: 'freezer', value: 0, words }));
      expect(result.structuredContent.outcome).toBe('refused');
      expect(event).toMatchObject({ kind: 'refusal', valueTenths: null });
    },
  );

  it('stores the value 0 beside "0 below", whose figure is the value', () => {
    const { event, result } = decided(walkIn({ check_point: 'freezer', value: 0, words: 'the freezer reads 0 below' }));
    expect(event).toMatchObject({ kind: 'reading', valueTenths: 0 });
    expect(result.structuredContent.outcome).toBe('in_range');
  });

  // A figure said in words after a sign is not a zero unless it is the zero word, so the value 0
  // beside "minus five" is a number the cook did not say, the same as beside "minus 5".
  it.each(['the freezer reads minus five', 'the freezer reads negative five', 'the freezer reads minus'])(
    'refuses the value 0 beside "%s", which says a reading below zero',
    (words) => {
      const { event, result } = decided(walkIn({ check_point: 'freezer', value: 0, words }));
      expect(result.structuredContent.outcome).toBe('refused');
      expect(event).toMatchObject({ kind: 'refusal', valueTenths: null });
    },
  );

  // "minus zero" is a zero, which takes no sign, so its words never turn another value negative: they
  // decide exactly as "minus 0" does.
  it.each([0, 5])('decides the value %d beside "minus zero" as it does beside "minus 0"', (value) => {
    const said = (words: string) => decided(walkIn({ check_point: 'freezer', value, words })).result.structuredContent;
    const inWords = said('the freezer reads minus zero');
    expect(inWords).toMatchObject({ value, outcome: said('the freezer reads minus 0').outcome });
    expect(inWords.outcome).not.toBe('refused');
  });

  // A zero word with another figure after it leaves the sign belonging to either, as "minus 0, 5
  // minutes ago" does. Read as a sign on the value, "minus zero, five minutes ago" beside 5 would
  // store -5 for a freezer that may read 5 and fail.
  it.each([
    ['the freezer reads minus zero, five minutes ago', 5],
    ['the freezer reads minus zero five', 5],
    ['the freezer reads minus zero point five', -0.5],
  ])('refuses the value beside "%s", whose sign could belong to either figure', (words, value) => {
    const { event, result } = decided(walkIn({ check_point: 'freezer', value, words }));
    expect(result.structuredContent.outcome).toBe('refused');
    expect(event).toMatchObject({ kind: 'refusal', valueTenths: null, promptKind: 'number' });
  });

  it.each([
    ['the freezer reads minus five, two minutes ago', -50],
    ['the freezer reads minus zero', 50],
  ])('stores the value 5 beside "%s" as %d tenths', (words, tenths) => {
    const { event } = decided(walkIn({ check_point: 'freezer', value: 5, words }));
    expect(event).toMatchObject({ kind: 'reading', valueTenths: tenths });
  });

  // Read as a plain zero, these words would store 0.5 for a freezer the cook said was below zero.
  it.each(['the freezer reads minus 0 point 5', 'the freezer reads -0 point 5'])(
    'refuses the value 0.5 beside "%s", whose sign could belong to either figure',
    (words) => {
      const { event, result } = decided(walkIn({ check_point: 'freezer', value: 0.5, words }));
      expect(result.structuredContent.outcome).toBe('refused');
      expect(event).toMatchObject({ kind: 'refusal', valueTenths: null });
    },
  );
});

// Written to break the sign rules: every value the contract accepts, beside words that give a sign.
describe('the sign the words give, against every value', () => {
  const contractTenths = fc.integer({ min: -4596, max: 10000 });
  const figure = fc.integer({ min: 1, max: 99 });
  // Each pairs the words with the magnitude they say, so the value can be the one the cook read and
  // every run must store it: a value drawn apart from the words would almost never match them.
  const saysBelowZero = fc.oneof(
    figure.map((m) => ({ words: `the freezer reads ${m} below`, magnitude: m })),
    figure.map((m) => ({ words: `the freezer is ${m} degrees below zero`, magnitude: m })),
    figure.map((m) => ({ words: `the freezer reads minus ${m}`, magnitude: m })),
    figure.map((m) => ({ words: `the freezer reads negative ${m}`, magnitude: m })),
    figure.map((m) => ({ words: `the freezer reads -${m}`, magnitude: m })),
    fc.constantFrom(
      { words: 'the freezer reads minus five', magnitude: 5 },
      { words: 'the freezer reads negative twelve', magnitude: 12 },
    ),
  );
  const saysAFigure = fc.oneof(
    figure.map((m) => ({ words: `the freezer reads ${m}`, magnitude: m })),
    fc
      .constantFrom('the freezer reads zero', 'the freezer reads 0', 'the freezer reads minus 0', 'the freezer reads minus zero', 'the freezer reads 0 below')
      .map((words) => ({ words, magnitude: 0 })),
  );
  const notAReading = fc.oneof(
    fc.tuple(fc.integer({ min: -4596, max: -1 }), saysAFigure.map(({ words }) => words)),
    fc.tuple(contractTenths, fc.constant('the freezer reads minus zero point five')),
  );

  function storedTenths(tenths: number, words: string): number | null {
    return decided(walkIn({ check_point: 'freezer', value: tenths / 10, words })).event.valueTenths ?? null;
  }

  it('stores the magnitude below zero beside words that say a reading below zero, whatever sign the value carries', () => {
    fc.assert(
      fc.property(saysBelowZero, fc.constantFrom(1, -1), ({ words, magnitude }, sign) => {
        expect(storedTenths(sign * magnitude * 10, words)).toBe(-magnitude * 10);
      }),
      { numRuns: 500 },
    );
  });

  it('stores the figure plain words name as given', () => {
    fc.assert(
      fc.property(saysAFigure, ({ words, magnitude }) => {
        expect(storedTenths(magnitude * 10, words)).toBe(magnitude * 10);
      }),
      { numRuns: 500 },
    );
  });

  it('refuses a value below zero beside plain words that name a figure, and any value beside words whose sign could belong to either figure', () => {
    fc.assert(
      fc.property(notAReading, ([tenths, words]) => {
        expect(storedTenths(tenths, words)).toBeNull();
      }),
      { numRuns: 500 },
    );
  });

  // The contract accepts -0, and a JSON body can carry it. Zero takes no sign.
  it.each(['the freezer reads 0', 'the freezer reads minus zero', undefined])('stores the value -0 beside %j as 0, never as -0', (words) => {
    const { event, result } = decided(walkIn({ check_point: 'freezer', value: -0, words }));
    expect(event.valueTenths).toBe(0);
    expect(result.structuredContent.value).toBe(0);
  });
});

describe('a check given with no number', () => {
  it('is refused under the one id it draws', () => {
    let drawn = 0;
    const counting: DecisionContext = { ...ctx, newId: () => `id-${++drawn}` };
    const decision = decideLogReading(walkIn({ value: undefined, words: 'the walk-in is fine' }), counting);
    expect(decision).toMatchObject({ status: 'decided', event: { kind: 'refusal', id: 'id-1' } });
    expect(drawn).toBe(1);
  });
});

describe('alreadyAnswered', () => {
  it('answers a call whose question could not be read back, naming no check when the call names none', () => {
    const decision = alreadyAnswered({ initials: 'mr', screen_id: 'wall', request_id: 'request-2' }, ctx, null);
    expect(decision.result.content[0].text).toBe('That question was already answered. Say the check and its number again.');
    expect(decision.result.structuredContent).not.toHaveProperty('checkPoint');
    expect(decision.event).toMatchObject({ kind: 'receipt', checkPointId: null, initials: 'MR', answersId: null });
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

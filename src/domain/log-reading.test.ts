import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import demoJson from '../../data/kitchens/demo.json';
import rulesJson from '../../data/rules/food-code-2022.json';
import { LogReadingInputSchema, LogReadingOutputSchema, type LogReadingInput } from '../contract/log-reading';
import { kitchenSettings } from './business-day';
import { alreadyAnswered, decideLogReading, selectRule, spokenReadback, type DecisionContext } from './log-reading';
import { KitchenProfileSchema, RuleTableSchema, type CheckPoint } from './rule';

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
    const { text } = spokenPair(walkIn({ value, words: `the walk-in reads ${value}` }));
    expect(text).toMatch(new RegExp(`^Walk-in, ${value}, `));
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

// Written to break the selection: each case is a profile shape the demo kitchen does not hold today,
// where a slip would judge a reading by a row that never applied to it.
describe('selectRule', () => {
  function checkPoint(id: string): CheckPoint {
    const found = profile.checkPoints.find((point) => point.id === id);
    if (!found) throw new Error(`the demo profile has no check point ${id}`);
    return found;
  }

  it.each(['cooling', 'reheat'])('keeps a %s reading unjudged even when its check point names a temperature row', (id) => {
    expect(selectRule({ ...checkPoint(id), airRule: 'unit_air_cold' }, 'air', profile, ctx.rules)).toBeUndefined();
  });

  it('judges a food that is no roast by the food rule at a check point that also holds a roast rule', () => {
    expect(selectRule(checkPoint('carving_station'), 'chicken_soup', profile, ctx.rules)?.id).toBe('hot_holding');
    expect(selectRule(checkPoint('carving_station'), 'prime_rib', profile, ctx.rules)?.id).toBe('hot_holding_roast');
  });

  // A default measured id is checked against no food list at load, so it can name a food that is not there.
  it('judges a measured id naming no food by the food rule, never failing on the missing food', () => {
    expect(selectRule(checkPoint('carving_station'), 'brisket', profile, ctx.rules)?.id).toBe('hot_holding');
  });

  it('leaves a reading that names nothing measured unjudged, even where a food rule exists', () => {
    expect(selectRule(checkPoint('walk_in'), undefined, profile, ctx.rules)).toBeUndefined();
  });

  it('leaves a reading unjudged when its rule id names a row with no single-reading limit', () => {
    const intervalAsAir = { ...checkPoint('walk_in'), airRule: 'cold_holding_check_interval' };
    expect(selectRule(intervalAsAir, 'air', profile, ctx.rules)).toBeUndefined();
  });
});

describe('the initials a call gives', () => {
  it.each(['', '  '])('asks who is logging when the initials are %j, never refusing them as off the roster', (initials) => {
    expect(decideLogReading(walkIn({ initials }), ctx)).toMatchObject({
      status: 'decided',
      result: { structuredContent: { outcome: 'held', prompt: { kind: 'who_is_logging' } } },
    });
  });

  // A dotless i upper-cases to I, so a roster holding MI would otherwise take "mı" as its own entry.
  it('refuses initials holding a letter outside A to Z, never upper-casing it into a roster entry', () => {
    const withMi: DecisionContext = { ...ctx, profile: KitchenProfileSchema.parse({ ...demoJson, roster: [...demoJson.roster, 'MI'] }) };
    expect(decideLogReading(walkIn({ initials: 'mı' }), withMi)).toEqual({ status: 'rejected', code: 'initials_not_on_roster' });
    expect(decideLogReading(walkIn({ initials: 'mi' }), withMi)).toMatchObject({ status: 'decided', event: { initials: 'MI' } });
  });
});

describe('a held reading', () => {
  it('stores the measured the call gave, and the check point default only when it gave none', () => {
    const given = decided(walkIn({ initials: undefined, measured: 'chicken_soup' }));
    const defaulted = decided(walkIn({ initials: undefined, measured: undefined }));
    expect(given.result.structuredContent.outcome).toBe('held');
    expect(given.event.measured).toBe('chicken_soup');
    expect(defaulted.event.measured).toBe('air');
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

// The host sends both the cook's words and the number it heard in them. When the two disagree, the
// record cannot tell which is right, so the call is refused and the number asked for again, never
// logged as a number the cook did not say with the cook's own words rewritten to match.
describe('a value beside words that name another figure', () => {
  it.each([
    ['the walk-in reads 38', 39, 'the walk-in reads 38'],
    ['the walk-in reads 41', 41.5, 'the walk-in reads 41'],
    ['the walk-in reads 38.5', 38, 'the walk-in reads 38.5'],
    ['the walk-in reads 38, 5 minutes ago', 5, 'the walk-in reads 38 5'],
    ['the walk-in reads 3 8', 39, 'the walk-in reads 3 8'],
    ['the walk-in reads 41 degrees', 41.9, 'the walk-in reads 41 degrees'],
    ['the walk-in reads 38 and a half', 38.9, 'the walk-in reads 38 a'],
    ['the walk-in reads 38 and a half', 38, 'the walk-in reads 38 a'],
    ['the walk-in reads 38 point 5', 38, 'the walk-in reads 38 5'],
    ['the walk-in shelf 2 reads 38', 38, 'the walk-in 2 reads 38'],
  ])('refuses "%s" beside the value %d and quotes the figures said', (words, value, stored) => {
    const { event, result } = decided(walkIn({ value, words }));
    expect(result.structuredContent).toMatchObject({ outcome: 'refused', prompt: { kind: 'number' } });
    expect(event).toMatchObject({ kind: 'refusal', valueTenths: null, verdict: null, words: stored });
  });

  it.each([
    ['the walk-in reads 38.0', 38],
    ['the walk-in reads 38 and a half', 38.5],
    ['the walk-in reads thirty eight', 38],
    ['the walk-in reads 3 8', 38],
    ['the walk-in reads 38 point 5', 38.5],
    ['the walk-in reads 3 8 point 5', 38.5],
    ['the walk-in reads 38 point five', 38.5],
    ['the walk-in reads 41 degrees', 41],
  ])('logs "%s" beside the value %d, a spelling of that same number', (words, value) => {
    expect(decided(walkIn({ value, words })).event).toMatchObject({ kind: 'reading', valueTenths: value * 10 });
  });

  it('logs "zero point 5" beside the value 0.5 at the freezer', () => {
    const { event } = decided(walkIn({ check_point: 'freezer', value: 0.5, words: 'the freezer reads zero point 5' }));
    expect(event).toMatchObject({ kind: 'reading', valueTenths: 5 });
  });

  it('logs the reach-in two at 38 when the only other digit is the one in its name', () => {
    const { event } = decided(walkIn({ check_point: 'reach_in_2', value: 38, words: 'the reach-in 2 reads 38' }));
    expect(event).toMatchObject({ kind: 'reading', checkPointId: 'reach_in_2', valueTenths: 380 });
  });
});

// The host also sends the check point and the food. Words that name others would have the reading
// judged by a rule that never applied to what the cook read, so the call is refused like a wrong number.
describe('a check point or food beside words that name another', () => {
  const DISPUTE = 'I could not match the check or food you said. Say the check and its number again.';

  it.each([
    ['soup_well', undefined, 'walk-in reads 38', 38],
    ['walk_in', undefined, 'the freezer reads 38', 38],
    ['walk_in', 'milk', 'the chicken soup in the walk-in reads 38', 38],
    ['carving_station', undefined, 'the chicken soup at the carving station reads 132', 132],
    ['soup_well', undefined, 'not the soup well, the walk-in reads 38', 38],
    ['soup_well', 'chicken_soup', 'the chili and chicken soup read 140', 140],
    ['walk_in', 'chicken_soup', 'walk-in air temperature reads 38', 38],
    ['walk_in', undefined, 'the soup in the walk-in reads 38', 38],
    ['receiving', undefined, 'the raw chicken reads 50', 50],
    ['receiving', undefined, 'the delivery air reads 50', 50],
  ])('refuses the check point %s with food %s beside "%s", saying the words do not match', (check_point, measured, words, value) => {
    const { event, result } = decided(walkIn({ check_point, measured, words, value }));
    expect(result.content[0].text).toBe(DISPUTE);
    expect(result.structuredContent).toMatchObject({ outcome: 'refused', prompt: { kind: 'number' } });
    expect(event).toMatchObject({ kind: 'refusal', checkPointId: check_point, valueTenths: null, verdict: null });
  });

  it.each([
    ['soup_well', undefined, 'the soup well reads 145', 145, 1450],
    ['freezer', undefined, 'the walk-in freezer reads minus 5', 5, -50],
    ['carving_station', undefined, 'the prime rib reads 132', 132, 1320],
    ['walk_in', 'chicken_soup', 'the soup in the walk-in reads 38', 38, 380],
    ['walk_in', undefined, 'the walk-in air reads 38', 38, 380],
    ['walk_in', 'air', 'well, the walk-in reads 38', 38, 380],
    ['receiving', 'raw_chicken', 'the raw chicken reads 40', 40, 400],
    ['cooling', undefined, 'the chicken soup cooling reads 70', 70, 700],
  ])('logs the check point %s with food %s beside "%s", which name the same', (check_point, measured, words, value, tenths) => {
    expect(decided(walkIn({ check_point, measured, words, value })).event).toMatchObject({ kind: 'reading', valueTenths: tenths });
  });

  // Receiving judges each food by its own row, so the words cannot pick one; a delivery said with no
  // food named stays unjudged, as before.
  it('keeps a receiving reading whose words name no food unjudged', () => {
    const { result } = decided(walkIn({ check_point: 'receiving', measured: undefined, words: 'the delivery reads 50', value: 50 }));
    expect(result.structuredContent.outcome).toBe('not_covered');
  });

  it('refuses before asking who is logging, so an answer of initials alone can never log it', () => {
    const { result } = decided(walkIn({ check_point: 'soup_well', measured: undefined, words: 'walk-in reads 38', initials: undefined }));
    expect(result.structuredContent).toMatchObject({ outcome: 'refused', prompt: { kind: 'number' } });
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
  // decide exactly as "minus 0" does, keeping a 0 beside them and refusing a 5, a figure they never say.
  it.each([
    [0, false],
    [5, true],
  ])('decides the value %d beside "minus zero" as it does beside "minus 0"', (value, refused) => {
    const said = (words: string) => decided(walkIn({ check_point: 'freezer', value, words })).result.structuredContent;
    const inWords = said('the freezer reads minus zero');
    expect(inWords.outcome).toBe(said('the freezer reads minus 0').outcome);
    expect(inWords.outcome === 'refused').toBe(refused);
    if (!refused) expect(inWords.value).toBe(value);
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

  it('stores the value 5 beside "the freezer reads minus five, two minutes ago" as -50 tenths', () => {
    const { event } = decided(walkIn({ check_point: 'freezer', value: 5, words: 'the freezer reads minus five, two minutes ago' }));
    expect(event).toMatchObject({ kind: 'reading', valueTenths: -50 });
  });

  // Signed words are held to every figure they say, as plain words are: a second figure is a second
  // reading or a time, and a fraction makes the figure another size.
  it.each([
    ['the freezer reads minus 5 and 7', -5],
    ['the freezer reads minus 5 and 7', 5],
    ['the freezer reads minus 5, 2 minutes ago', 5],
    ['the freezer reads minus 5 point 5', 5],
    ['the freezer reads minus 5 and a half', -5],
  ])('refuses "%s" beside the value %d, which names another figure', (words, value) => {
    const { event, result } = decided(walkIn({ check_point: 'freezer', value, words }));
    expect(result.structuredContent.outcome).toBe('refused');
    expect(event).toMatchObject({ kind: 'refusal', valueTenths: null });
  });

  it.each([
    ['the freezer reads minus 5 point 5', 5.5, -55],
    ['the freezer reads minus 5 and a half', -5.5, -55],
    ['the freezer is 5 degrees below zero', 5, -50],
    ['the freezer reads minus 1 5', 15, -150],
  ])('stores "%s" beside the value %d as %d tenths', (words, value, tenths) => {
    expect(decided(walkIn({ check_point: 'freezer', value, words })).event).toMatchObject({ kind: 'reading', valueTenths: tenths });
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

  it('keeps a reading said below zero whose magnitude is exactly the lowest the contract accepts', () => {
    const { event, result } = decided(walkIn({ check_point: 'freezer', value: 459.6, words: 'the freezer reads minus 459.6' }));
    expect(result.structuredContent.outcome).not.toBe('refused');
    expect(event.valueTenths).toBe(-4596);
  });

  // A number word names a figure the way digits do, so a value below zero beside any of them is a
  // number the cook did not say.
  it('refuses a value below zero beside plain words that name a figure in any number word', () => {
    const numberWords = [
      'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
      'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty',
      'seventy', 'eighty', 'ninety', 'hundred',
    ];
    for (const word of numberWords) {
      const { result } = decided(walkIn({ check_point: 'freezer', value: -5, words: `the freezer reads ${word}` }));
      expect(result.structuredContent.outcome, word).toBe('refused');
    }
  });
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

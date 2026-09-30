import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import demoJson from '../../data/kitchens/demo.json';
import rulesJson from '../../data/rules/food-code-2022.json';
import { describeSource } from './citation';
import { judgeReading } from './judge';
import { selectRule } from './log-reading';
import { KitchenProfileSchema, RuleTableSchema, temperatureRowFrom, type RuleRow, type RuleTable, type TemperatureRow } from './rule';

// Typed by hand from the FDA Food Code 2022 text (fda.gov media 164194) and, for milk, the Grade "A"
// Pasteurized Milk Ordinance 2025 Revision (fda.gov media 193438). Never built from the JSON: the
// table has to agree with this, not with itself.
interface Facts {
  kind: RuleRow['kind'];
  source: 'food_code' | 'other_law';
  section: string;
  comparator?: 'at_most' | 'at_least';
  limitF?: number;
  limitC?: number;
  withinMinutes?: number;
  fromF?: number;
  holdSeconds?: number;
  minutes?: number;
  states?: string[];
  passingStates?: string[];
}

interface FixtureEntry extends Facts {
  id: string;
  quote: string;
  times?: string;
}

const FIXTURE: FixtureEntry[] = [
  {
    id: 'cold_holding',
    kind: 'temperature',
    source: 'food_code',
    section: '3-501.16(A)(2)',
    quote: 'At 5°C (41°F) or less',
    comparator: 'at_most',
    limitF: 41,
    limitC: 5,
  },
  {
    id: 'hot_holding',
    kind: 'temperature',
    source: 'food_code',
    section: '3-501.16(A)(1)',
    quote: 'At 57°C (135°F) or above',
    comparator: 'at_least',
    limitF: 135,
    limitC: 57,
  },
  {
    id: 'hot_holding_roast',
    kind: 'temperature',
    source: 'food_code',
    section: '3-501.16(A)(1)',
    quote: 'may be held at a temperature of 54°C (130°F) or above',
    comparator: 'at_least',
    limitF: 130,
    limitC: 54,
  },
  {
    id: 'receiving_cold',
    kind: 'temperature',
    source: 'food_code',
    section: '3-202.11(A)',
    quote: 'shall be at a temperature of 5°C (41°F) or below when received',
    comparator: 'at_most',
    limitF: 41,
    limitC: 5,
  },
  {
    id: 'receiving_hot',
    kind: 'temperature',
    source: 'food_code',
    section: '3-202.11(D)',
    quote: 'received hot shall be at a temperature of 57°C (135°F) or above',
    comparator: 'at_least',
    limitF: 135,
    limitC: 57,
  },
  {
    id: 'receiving_law_milk',
    kind: 'temperature',
    source: 'other_law',
    section: '3-202.11(B)',
    quote: 'shall be stored at a temperature of 7°C (45°F) or less',
    comparator: 'at_most',
    limitF: 45,
    limitC: 7,
  },
  {
    id: 'cooling_stage_1',
    kind: 'timed_temperature',
    source: 'food_code',
    section: '3-501.14(A)(1)',
    quote: 'Within 2 hours from 57°C (135°F) to 21°C (70°F)',
    comparator: 'at_most',
    limitF: 70,
    limitC: 21,
    withinMinutes: 120,
    fromF: 135,
  },
  {
    id: 'cooling_stage_2',
    kind: 'timed_temperature',
    source: 'food_code',
    section: '3-501.14(A)(2)',
    quote: 'Within a total of 6 hours from 57°C (135°F) to 5°C (41°F) or less',
    comparator: 'at_most',
    limitF: 41,
    limitC: 5,
    withinMinutes: 360,
    fromF: 135,
  },
  {
    id: 'reheat_hot_holding',
    kind: 'timed_temperature',
    source: 'food_code',
    section: '3-403.11(A)',
    quote: 'reach a temperature of at least 74°C (165°F) for 15 seconds',
    comparator: 'at_least',
    limitF: 165,
    limitC: 74,
    holdSeconds: 15,
  },
  {
    id: 'reheat_time',
    kind: 'duration',
    source: 'food_code',
    section: '3-403.11(D)',
    quote: 'between 5°C (41°F) and the temperatures specified under §§ (A) - (C) of this section may not exceed 2 hours',
    minutes: 120,
    fromF: 41,
    times: 'reheat',
  },
  {
    id: 'received_frozen',
    kind: 'observation',
    source: 'food_code',
    section: '3-202.11(E)',
    quote: 'shall be received frozen',
    states: ['frozen solid', 'thawed or soft', 'ice crystals or refrozen'],
    passingStates: ['frozen solid'],
  },
  {
    id: 'frozen_storage',
    kind: 'observation',
    source: 'food_code',
    section: '3-501.11',
    quote: 'Stored frozen FOODS shall be maintained frozen',
    states: ['frozen solid', 'thawed or soft', 'ice crystals or refrozen'],
    passingStates: ['frozen solid'],
  },
  {
    id: 'no_temperature_abuse',
    kind: 'observation',
    source: 'food_code',
    section: '3-202.11(F)',
    quote: 'free of evidence of previous temperature abuse',
    states: ['no sign of abuse', 'thawed or soft', 'ice crystals or refrozen'],
    passingStates: ['no sign of abuse'],
  },
];

const RULE_IDS = [
  'cold_holding',
  'hot_holding',
  'hot_holding_roast',
  'receiving_cold',
  'receiving_hot',
  'receiving_law_milk',
  'unit_air_cold',
  'unit_air_hot',
  'cooling_stage_1',
  'cooling_stage_2',
  'reheat_hot_holding',
  'reheat_time',
  'received_frozen',
  'frozen_storage',
  'no_temperature_abuse',
  'freezer_limit',
  'hot_holding_check_interval',
  'cold_holding_check_interval',
  'cold_holding_fix_deadline',
  'hot_holding_fix_deadline',
  'house_window',
];

const NOT_COVERED_SECTIONS = [
  '3-202.11(C)',
  '3-501.14(B)',
  '3-501.14(C)',
  '3-501.16(B)',
  '3-501.16(C)',
  '3-501.19',
  '3-403.11(B)',
  '3-403.11(C)',
];

const TENTHS = 10;
const BOUNDARY_OFFSETS = [-10, -1, 0, 1, 10];
const TEMPERATURE_FIELDS = ['comparator', 'limitFTenths', 'limitC'];

const table: RuleTable = RuleTableSchema.parse(rulesJson);
const profile = KitchenProfileSchema.parse(demoJson);
const rawRows = (rulesJson as { rows: Record<string, unknown>[] }).rows;

function rowById(id: string): RuleRow | undefined {
  return table.rows.find((row) => row.id === id);
}

function sourceSection(row: RuleRow): string | undefined {
  return row.source.kind === 'house_rule' ? undefined : row.source.section;
}

function factsOf(row: RuleRow): Partial<Facts> {
  const common = { kind: row.kind, source: row.source.kind, section: sourceSection(row) } as Partial<Facts>;
  switch (row.kind) {
    case 'temperature':
      return { ...common, comparator: row.comparator, limitF: row.limitFTenths / TENTHS, limitC: row.limitC };
    case 'timed_temperature':
      return {
        ...common,
        comparator: row.comparator,
        limitF: row.limitFTenths / TENTHS,
        limitC: row.limitC,
        withinMinutes: row.withinMinutes,
        fromF: row.fromFTenths === undefined ? undefined : row.fromFTenths / TENTHS,
        holdSeconds: row.holdSeconds,
      };
    case 'duration':
      return {
        ...common,
        minutes: row.minutes,
        fromF: row.fromFTenths === undefined ? undefined : row.fromFTenths / TENTHS,
      };
    case 'observation':
      return { ...common, states: row.states, passingStates: row.passingStates };
  }
}

function fixtureFacts(entry: FixtureEntry): Partial<Facts> {
  const { id: _id, quote: _quote, times: _times, ...facts } = entry;
  return facts;
}

interface BoundaryCase {
  id: string;
  valueTenths: number;
  expected: 'in_range' | 'out_of_range';
}

const JUDGED = FIXTURE.filter((entry) => entry.kind === 'temperature');

// The expected verdict comes from the Code's inclusive wording ("or less", "or above"), read off the
// fixture, so a wrong limit in the table cannot also move the expectation.
const BOUNDARY_CASES: BoundaryCase[] = JUDGED.flatMap((entry) =>
  BOUNDARY_OFFSETS.map((offset) => {
    const limitTenths = (entry.limitF ?? Number.NaN) * TENTHS;
    const valueTenths = limitTenths + offset;
    const passes = entry.comparator === 'at_most' ? valueTenths <= limitTenths : valueTenths >= limitTenths;
    return { id: entry.id, valueTenths, expected: passes ? 'in_range' : 'out_of_range' };
  }),
);

function temperatureRow(id: string, rows: ReadonlyMap<string, RuleRow> = new Map(table.rows.map((r) => [r.id, r]))) {
  const row = rows.get(id);
  if (row?.kind !== 'temperature') throw new Error(`${id} is not a temperature row in the table`);
  return row;
}

describe('the rule table against the hand-typed fixture', () => {
  it('matches every fixture entry to the table row with its id, kind, section and facts', () => {
    const matched = FIXTURE.filter((entry) => rowById(entry.id) !== undefined);
    expect(matched.length).toBeGreaterThan(0);
    expect(matched.map((entry) => entry.id)).toEqual(FIXTURE.map((entry) => entry.id));
    for (const entry of FIXTURE) {
      const row = rowById(entry.id);
      expect(row, entry.id).toBeDefined();
      if (!row) continue;
      expect(factsOf(row), entry.id).toEqual(fixtureFacts(entry));
      expect(row.source.kind === 'house_rule' ? '' : row.source.quote, entry.id).toContain(entry.quote);
      if (entry.times !== undefined) expect(row.kind === 'duration' ? row.times : '', entry.id).toContain(entry.times);
    }
  });

  it('has a fixture entry for every row sourced to the Food Code or another law', () => {
    const sourced = table.rows.filter((row) => row.source.kind !== 'house_rule');
    const fixtureIds = new Set(FIXTURE.map((entry) => entry.id));
    expect(sourced.length).toBeGreaterThan(0);
    expect(sourced.filter((row) => fixtureIds.has(row.id)).length).toBe(FIXTURE.length);
    expect(sourced.map((row) => row.id).filter((id) => !fixtureIds.has(id))).toEqual([]);
  });

  it('names the milk row after the Pasteurized Milk Ordinance', () => {
    const milk = rowById('receiving_law_milk');
    expect(milk?.source).toMatchObject({ kind: 'other_law', name: expect.stringContaining('Pasteurized Milk Ordinance') });
  });
});

describe('boundary cases generated from the fixture', () => {
  it('generates five cases for every judged fixture entry', () => {
    expect(JUDGED.length).toBeGreaterThan(0);
    expect(BOUNDARY_CASES).toHaveLength(BOUNDARY_OFFSETS.length * JUDGED.length);
  });

  it.each(BOUNDARY_CASES)('judges $id at $valueTenths tenths $expected', ({ id, valueTenths, expected }) => {
    expect(judgeReading(valueTenths, temperatureRow(id))).toBe(expected);
  });

  it('passes 41.0 and fails 41.4 for cold holding', () => {
    expect(judgeReading(410, temperatureRow('cold_holding'))).toBe('in_range');
    expect(judgeReading(414, temperatureRow('cold_holding'))).toBe('out_of_range');
  });

  it('passes 135.0 and fails 134.9 for hot holding (E19)', () => {
    expect(judgeReading(1350, temperatureRow('hot_holding'))).toBe('in_range');
    expect(judgeReading(1349, temperatureRow('hot_holding'))).toBe('out_of_range');
  });

  it('judges on the Fahrenheit tenths alone, whatever the Celsius figure says (E20)', () => {
    const row = temperatureRow('cold_holding');
    const skewed: TemperatureRow = { ...row, limitC: -273 };
    for (const valueTenths of [400, 410, 411]) {
      expect(judgeReading(valueTenths, skewed)).toBe(judgeReading(valueTenths, row));
    }
  });

  it('gives the same verdicts at every check point whatever order the rows are loaded in', () => {
    const measures = ['air', ...profile.foods.map((food) => food.id)];
    const verdicts = (rows: readonly RuleRow[]) => {
      const byId = new Map(rows.map((row) => [row.id, row]));
      return profile.checkPoints.flatMap((point) =>
        measures.flatMap((measured) => {
          const rule = selectRule(point, measured, profile, byId);
          return BOUNDARY_CASES.map((c) => (rule ? `${rule.id}:${judgeReading(c.valueTenths, rule)}` : 'not_covered'));
        }),
      );
    };
    const baseline = verdicts(table.rows);
    fc.assert(
      fc.property(fc.shuffledSubarray(table.rows, { minLength: table.rows.length }), (shuffled) => {
        const reloaded = RuleTableSchema.parse({ ...rulesJson, rows: shuffled });
        expect(verdicts(reloaded.rows)).toEqual(baseline);
      }),
      { numRuns: 25 },
    );
  });
});

describe('the shape of each row kind', () => {
  it('holds exactly the rule ids of RULE-02 and no folded reheat clock row', () => {
    expect(table.rows.map((row) => row.id).sort()).toEqual([...RULE_IDS].sort());
    expect(rowById('reheat_clock_one_hour')).toBeUndefined();
  });

  it('gives every row a kind, and no duration or observation row a temperature field', () => {
    for (const raw of rawRows) {
      expect(['temperature', 'timed_temperature', 'duration', 'observation']).toContain(raw.kind);
      if (raw.kind === 'duration' || raw.kind === 'observation') {
        for (const field of TEMPERATURE_FIELDS) expect(raw, `${String(raw.id)} ${field}`).not.toHaveProperty(field);
      }
    }
  });

  it('gives every row with a temperature limit both a Fahrenheit and a Celsius figure (E20)', () => {
    const limited = table.rows.filter((row) => row.kind === 'temperature' || row.kind === 'timed_temperature');
    expect(limited.length).toBeGreaterThan(0);
    for (const row of limited) {
      expect(Number.isInteger(row.limitFTenths), row.id).toBe(true);
      expect(typeof row.limitC, row.id).toBe('number');
    }
  });

  it('records whether each Food Code row was checked against the 2026 text', () => {
    for (const row of table.rows) {
      if (row.source.kind === 'food_code') expect(typeof row.source.unchanged2026, row.id).toBe('boolean');
    }
  });

  it('states its reading of the first cooling stage, which has no inclusive word', () => {
    expect(rowById('cooling_stage_1')?.source).toMatchObject({ interpretation: 'at or below 70°F' });
  });

  it('lists the eight Food Code paragraphs it does not cover', () => {
    expect(table.notCovered.map((entry) => entry.section)).toEqual(NOT_COVERED_SECTIONS);
    for (const entry of table.notCovered) expect(entry.description.length).toBeGreaterThan(0);
  });
});

describe('RuleTableSchema', () => {
  const base = { rulesVersion: 'test', edition: 'FDA Food Code 2022', notCovered: [] };
  const durationRow = {
    kind: 'duration',
    id: 'check_interval',
    minutes: 60,
    times: 'time between checks',
    source: { kind: 'house_rule', reason: 'the kitchen checks hourly' },
  };
  const observationRow = {
    kind: 'observation',
    id: 'frozen_check',
    states: ['frozen solid', 'thawed or soft'],
    passingStates: ['frozen solid'],
    source: { kind: 'house_rule', reason: 'the kitchen looks at the freezer' },
  };

  it('accepts a duration row and refuses the same row carrying a comparator and limits', () => {
    expect(RuleTableSchema.safeParse({ ...base, rows: [durationRow] }).success).toBe(true);
    const withLimit = { ...durationRow, comparator: 'at_most', limitFTenths: 410, limitC: 5 };
    expect(RuleTableSchema.safeParse({ ...base, rows: [withLimit] }).success).toBe(false);
  });

  it('accepts an observation row and refuses the same row carrying a limit', () => {
    expect(RuleTableSchema.safeParse({ ...base, rows: [observationRow] }).success).toBe(true);
    expect(RuleTableSchema.safeParse({ ...base, rows: [{ ...observationRow, limitFTenths: 0 }] }).success).toBe(false);
  });

  it('refuses a house rule that carries a Code section (N2)', () => {
    const cited = { ...durationRow, source: { ...durationRow.source, section: '3-501.16(A)(2)' } };
    expect(RuleTableSchema.safeParse({ ...base, rows: [durationRow] }).success).toBe(true);
    expect(RuleTableSchema.safeParse({ ...base, rows: [cited] }).success).toBe(false);
  });

  const refusal = (rows: unknown[]): string[] => {
    const parsed = RuleTableSchema.safeParse({ ...base, rows });
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
  };

  it('refuses two rows that share an id', () => {
    expect(refusal([durationRow, { ...durationRow, minutes: 30 }])).toContain('two rows share an id');
  });

  it('refuses a timed temperature row with no time bound, and accepts it with one', () => {
    const timed = {
      kind: 'timed_temperature',
      id: 'cooling_stage',
      comparator: 'at_most',
      limitFTenths: 700,
      limitC: 21,
      source: { kind: 'house_rule', reason: 'the kitchen cools in stages' },
    };
    expect(refusal([timed])).toContain('cooling_stage is timed but carries no time bound');
    expect(refusal([{ ...timed, withinMinutes: 120 }])).toEqual([]);
  });

  it('refuses an observation row that passes a state it does not list', () => {
    expect(refusal([{ ...observationRow, passingStates: ['frozen hard'] }])).toContain(
      'frozen_check passes a state it does not list',
    );
  });

  it('refuses a house rule that tightens a row the table lacks', () => {
    const tightening = { ...durationRow, source: { ...durationRow.source, tightens: 'reheat_time' } };
    expect(refusal([tightening])).toContain('check_interval tightens reheat_time, which the table lacks');
  });
});

// A fault log keeps only an error's name and code, so the code must say it was a stored rule copy
// whether that copy is not JSON at all or JSON of another shape.
describe('temperatureRowFrom', () => {
  function codeOf(copy: string): unknown {
    try {
      temperatureRowFrom(copy);
    } catch (error) {
      return (error as { code?: unknown }).code;
    }
    return 'read';
  }

  it('reads a stored copy of a temperature row, and names the copy in the code of every refusal', () => {
    expect(codeOf(JSON.stringify(temperatureRow('cold_holding')))).toBe('read');
    expect(codeOf('not json')).toBe('rule_snapshot_unreadable');
    expect(codeOf(JSON.stringify({ ...temperatureRow('cold_holding'), limitFTenths: undefined, limitF: 41 }))).toBe('rule_snapshot_unreadable');
  });
});

describe('describeSource', () => {
  const houseRuleWithReason = (row: RuleRow) => (row.source.kind === 'house_rule' ? row.source.reason : '');

  it('shows a Food Code row as the edition and section', () => {
    expect(describeSource(temperatureRow('cold_holding'), table)).toBe('Food Code 2022 3-501.16(A)(2)');
  });

  it('shows the milk row by the law it comes from', () => {
    const milk = rowById('receiving_law_milk');
    if (!milk) throw new Error('receiving_law_milk is missing');
    expect(describeSource(milk, table)).toMatch(/^Grade "A" Pasteurized Milk Ordinance/);
  });

  it('shows a house rule that tightens a Code value beside the Code value it tightens', () => {
    const tighter: RuleRow = {
      kind: 'temperature',
      id: 'walk_in_house_limit',
      comparator: 'at_most',
      limitFTenths: 380,
      limitC: 3,
      source: { kind: 'house_rule', reason: 'this kitchen holds its walk-in at 38°F or less', tightens: 'cold_holding' },
    };
    const withTighter: RuleTable = { ...table, rows: [...table.rows, tighter] };
    expect(describeSource(tighter, withTighter)).toBe(
      'house rule: this kitchen holds its walk-in at 38°F or less, stricter than Food Code 2022 3-501.16(A)(2), 41°F or less',
    );
  });

  it.each([
    ['reheat_time', 'Food Code 2022 3-403.11(D), 120 minutes'],
    ['frozen_storage', 'Food Code 2022 3-501.11, frozen solid'],
    ['hot_holding', 'Food Code 2022 3-501.16(A)(1), 135°F or above'],
  ])('shows a house rule tightening %s beside that Code figure', (tightens, codeFigure) => {
    const tighter: RuleRow = {
      kind: 'duration',
      id: 'house_tighter',
      minutes: 30,
      times: 'the kitchen acts sooner',
      source: { kind: 'house_rule', reason: 'this kitchen acts sooner', tightens },
    };
    const withTighter: RuleTable = { ...table, rows: [...table.rows, tighter] };
    expect(describeSource(tighter, withTighter)).toBe(`house rule: this kitchen acts sooner, stricter than ${codeFigure}`);
  });

  it.each(['hot_holding_fix_deadline', 'cold_holding_fix_deadline'])(
    'shows %s as a house rule where the Food Code sets no limit, with no Code section (N2)',
    (id) => {
      const row = rowById(id);
      if (!row) throw new Error(`${id} is missing`);
      const text = describeSource(row, table);
      expect(text).toBe(`house rule: ${houseRuleWithReason(row)}; the Food Code sets no limit here`);
      expect(text).not.toMatch(/\d-\d{3}\.\d{2}/);
    },
  );

  it('keeps the one-hour reheat clock in hot_holding_fix_deadline with no tightens field', () => {
    const row = rowById('hot_holding_fix_deadline');
    expect(row).toMatchObject({ kind: 'duration', minutes: 60 });
    expect(row?.source).not.toHaveProperty('tightens');
  });

  it('starts every house rule with "house rule"', () => {
    const houseRows = table.rows.filter((row) => row.source.kind === 'house_rule');
    expect(houseRows.length).toBeGreaterThan(0);
    for (const row of houseRows) expect(describeSource(row, table), row.id).toMatch(/^house rule: /);
  });
});

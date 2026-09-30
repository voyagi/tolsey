import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import demoJson from '../../data/kitchens/demo.json';
import rulesJson from '../../data/rules/food-code-2022.json';
import { selectRule } from './log-reading';
import { KitchenProfileSchema, RuleTableSchema, type CheckPoint, type RuleRow } from './rule';
import { tokensOf } from './words';

const profile = KitchenProfileSchema.parse(demoJson);
const table = RuleTableSchema.parse(rulesJson);
const rules: ReadonlyMap<string, RuleRow> = new Map(table.rows.map((row) => [row.id, row]));

const MINUTES_PER_HOUR = 60;
const DEFAULT_GRACE_MINUTES = 10;
const INVENTED_ROSTER = ['AB', 'MR', 'JT', 'KL'];
const BLANK_PHRASE = '?!';
const PHRASE_MESSAGE = 'a phrase holds at least one word or figure';

type Vocabulary = typeof demoJson.vocabulary;

const HOLDING = [
  { kind: 'hot', check: 'hot_holding', interval: 'hot_holding_check_interval' },
  { kind: 'cold', check: 'cold_holding', interval: 'cold_holding_check_interval' },
] as const;

function minutesOf(clock: string): number {
  const [hours, minutes] = clock.split(':').map(Number);
  return hours * MINUTES_PER_HOUR + minutes;
}

function ruleIdsOf(point: CheckPoint): string[] {
  return [point.airRule, point.foodRule, point.roastRule, ...Object.values(point.foodRules ?? {})].filter(
    (id): id is string => id !== undefined,
  );
}

describe('the demo kitchen schedule (SCHED-01)', () => {
  it.each(HOLDING)('schedules a $check check on every $kind point at its house-rule interval', ({ kind, check, interval }) => {
    const points = profile.checkPoints.filter((point) => point.kind === kind);
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      const entries = profile.schedule.filter((entry) => entry.checkPoint === point.id && entry.check === check);
      expect(entries, point.id).toHaveLength(1);
      expect(entries[0].intervalRule).toBe(interval);
    }
  });

  it('references a duration row sourced as a house rule with a reason for every interval', () => {
    for (const entry of profile.schedule) {
      const row = rules.get(entry.intervalRule);
      expect(row?.kind, entry.id).toBe('duration');
      expect(row?.source.kind, entry.id).toBe('house_rule');
      expect(row?.source.kind === 'house_rule' ? row.source.reason : '', entry.id).not.toBe('');
    }
  });

  it('spaces each point\'s due times by its interval row and gives each entry a ten minute grace window', () => {
    for (const entry of profile.schedule) {
      const row = rules.get(entry.intervalRule);
      const gaps = entry.times.slice(1).map((time, index) => minutesOf(time) - minutesOf(entry.times[index]));
      expect(entry.times.length, entry.id).toBeGreaterThan(1);
      expect(new Set(gaps), entry.id).toEqual(new Set([row?.kind === 'duration' ? row.minutes : Number.NaN]));
      expect(entry.graceMinutes, entry.id).toBe(DEFAULT_GRACE_MINUTES);
    }
  });

  it('keeps opening and closing checklist items as data', () => {
    expect(profile.checklist.opening.length).toBeGreaterThan(0);
    expect(profile.checklist.closing.length).toBeGreaterThan(0);
  });
});

describe('the demo kitchen profile', () => {
  it('holds only the invented two-letter roster', () => {
    expect(profile.roster).toEqual(INVENTED_ROSTER);
    for (const initials of profile.roster) expect(initials).toMatch(/^[A-Z]{2}$/);
  });

  it('states that no food is held under time as a public health control', () => {
    expect(profile.noTimeAsPublicHealthControl).toMatch(/time as a public health control/);
    expect(profile.noTimeAsPublicHealthControl).toMatch(/3-501\.19/);
  });

  it('keeps the correction window and prompt expiry as house choices', () => {
    expect(profile.correctionWindowSeconds).toBe(120);
    expect(profile.promptExpirySeconds).toBe(120);
  });

  it('gives every check kind a coarse band, and the freezer band holds 5 below', () => {
    for (const point of profile.checkPoints) expect(profile.coarseBands[point.kind], point.kind).toBeDefined();
    const freezer = profile.coarseBands.freezer;
    expect(freezer.lowF).toBeLessThanOrEqual(-5);
    expect(freezer.highF).toBeGreaterThanOrEqual(-5);
  });

  it('names only rules the table holds', () => {
    for (const point of profile.checkPoints) {
      for (const id of ruleIdsOf(point)) expect(rules.has(id), `${point.id} ${id}`).toBe(true);
    }
  });

  it('gives each receiving food its own rule and receiving no default measure', () => {
    const receiving = profile.checkPoints.find((point) => point.id === 'receiving');
    expect(receiving?.foodRules).toEqual({
      raw_chicken: 'receiving_cold',
      catered_chili: 'receiving_hot',
      milk: 'receiving_law_milk',
    });
    expect(receiving?.defaultMeasured).toBeUndefined();
  });

  it('selects a row at its own check point for every default measure', () => {
    const withDefault = profile.checkPoints.filter((point) => point.defaultMeasured !== undefined);
    expect(withDefault.map((point) => point.id).sort()).toEqual(
      ['carving_station', 'freezer', 'reach_in_1', 'reach_in_2', 'soup_well', 'walk_in'].sort(),
    );
    for (const point of withDefault) {
      expect(selectRule(point, point.defaultMeasured, profile, rules), point.id).toBeDefined();
    }
  });

  // A phrase is found as words inside what the cook said, so one that holds no word would be found in
  // every call that says none, turning silence into a correction or a hedge: refused at load.
  it.each<[string, (vocabulary: Vocabulary) => Vocabulary]>([
    ['correction', (vocabulary) => ({ ...vocabulary, corrections: [...vocabulary.corrections, BLANK_PHRASE] })],
    ['hedge', (vocabulary) => ({ ...vocabulary, hedges: { ...vocabulary.hedges, phrases: [...vocabulary.hedges.phrases, BLANK_PHRASE] } })],
  ])('refuses a %s phrase that holds no word', (_, withBlank) => {
    const parsed = KitchenProfileSchema.safeParse({ ...demoJson, vocabulary: withBlank(demoJson.vocabulary) });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([PHRASE_MESSAGE]);
  });

  // The schema's check and the matcher must agree: a phrase the schema takes gives at least one word,
  // whatever characters it is written in.
  it('takes a phrase only when the matcher reads at least one word in it', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', minLength: 1, maxLength: 12 }), (phrase) => {
        const parsed = KitchenProfileSchema.safeParse({ ...demoJson, vocabulary: { ...demoJson.vocabulary, corrections: [phrase] } });
        expect(parsed.success && tokensOf(phrase).length === 0, phrase).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it('holds every check point the demo kitchen walks through', () => {
    expect(profile.checkPoints.map((point) => point.id)).toEqual([
      'walk_in',
      'reach_in_1',
      'reach_in_2',
      'soup_well',
      'carving_station',
      'receiving',
      'freezer',
      'cooling',
      'reheat',
    ]);
  });
});

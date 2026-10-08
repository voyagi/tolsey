import { describe, expect, it } from 'vitest';
import demoJson from '../../data/kitchens/demo.json';
import rulesJson from '../../data/rules/food-code-2022.json';
import { NO_LINKS, type DecisionContext, type Facts } from './decision';
import { refusalDecision } from './refusal';
import { KitchenProfileSchema, RuleTableSchema } from './rule';

const table = RuleTableSchema.parse(rulesJson);
const profile = KitchenProfileSchema.parse(demoJson);
const walkIn = profile.checkPoints.find((point) => point.id === 'walk_in');

const ctx: DecisionContext = {
  now: Date.UTC(2026, 9, 20, 19, 0),
  newId: () => 'line-1',
  kitchen: { id: 'kitchen-1', timeZone: 'America/Chicago', dayStart: '04:00' },
  rules: new Map(table.rows.map((row) => [row.id, row])),
  rulesVersion: table.rulesVersion,
  profile,
};

function numberless(overrides: Partial<Facts> = {}): Facts {
  return { checkPoint: walkIn, initials: 'AB', words: 'the walk-in is fine', screenId: 'wall', requestId: 'request-1', ...overrides };
}

describe('refusalDecision', () => {
  it('refuses a check given with no number and asks for the number', () => {
    expect(refusalDecision(numberless(), ctx, NO_LINKS)).toMatchObject({
      status: 'decided',
      event: { kind: 'refusal', outcome: 'refused', checkPointId: 'walk_in', valueTenths: null, promptKind: 'number' },
      result: { content: [{ text: 'I need the number on the thermometer. What does the walk-in read?' }] },
    });
  });

  it('stores the outcome refused whether or not the call names a check', () => {
    for (const checkPoint of [walkIn, undefined]) {
      expect(refusalDecision(numberless({ checkPoint }), ctx, NO_LINKS)).toMatchObject({ event: { outcome: 'refused' } });
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import demoJson from '../../data/kitchens/demo.json';

const PROFILE_PATH = '../../data/kitchens/demo.json';

// The demo profile with one check point changed, the way a hand edit of the profile file could.
function profileWith(pointId: string, change: Record<string, unknown>): typeof demoJson {
  const profile = structuredClone(demoJson);
  const point = profile.checkPoints.find((candidate) => candidate.id === pointId);
  if (!point) throw new Error(`no check point ${pointId} in the demo profile`);
  Object.assign(point, change);
  return profile;
}

const BROKEN: [string, string, Record<string, unknown>, string][] = [
  [
    'an air rule the table lacks',
    'walk_in',
    { airRule: 'unit_air_cool' },
    'check point walk_in names rule unit_air_cool, which the rule table lacks',
  ],
  [
    'a food rule the table lacks',
    'receiving',
    { foodRules: { milk: 'receiving_milk' } },
    'check point receiving names rule receiving_milk, which the rule table lacks',
  ],
  [
    'a default measure that is neither air nor a food',
    'carving_station',
    { defaultMeasured: 'prime_ribs' },
    'check point carving_station defaults to prime_ribs, which is not a known measure',
  ],
];

// The profile is checked against the rule table while the module loads, so each case loads it
// afresh with its own profile in place of the shipped one.
describe('loading the kitchen data', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock(PROFILE_PATH);
    vi.resetModules();
  });

  it('loads a profile that names only rules and measures it has, and serves the profile it was given', async () => {
    vi.doMock(PROFILE_PATH, () => ({ default: profileWith('walk_in', { name: 'Walk-in cooler' }) }));
    const data = await import('./data');
    expect(data.DEMO_PROFILE.checkPoints.find((point) => point.id === 'walk_in')?.name).toBe('Walk-in cooler');
  });

  it.each(BROKEN)('refuses to load a profile whose check point names %s', async (_label, pointId, change, message) => {
    vi.doMock(PROFILE_PATH, () => ({ default: profileWith(pointId, change) }));
    await expect(import('./data')).rejects.toThrow(message);
  });
});

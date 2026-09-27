import { describe, expect, it } from 'vitest';
import demoJson from '../../data/kitchens/demo.json';
import { PROBE_DAY_START, PROBE_ZONE, Q4_INSTANTS } from '../test-support/q4-instants';
import { businessDay, kitchenSettings, lineTimeLabel, localParts, recordCode, validateDayStart } from './business-day';
import { KitchenProfileSchema } from './rule';

const at = (iso: string) => Date.parse(iso);
const dayAt = (iso: string) => businessDay(at(iso), PROBE_ZONE, PROBE_DAY_START);

describe('the business day', () => {
  it('keeps 11:30 PM and 12:30 AM on the same business day', () => {
    expect(dayAt('2026-10-21T04:30:00Z')).toBe('2026-10-20');
    expect(dayAt('2026-10-21T05:30:00Z')).toBe('2026-10-20');
  });

  it('starts the new business day at exactly 04:00 local and keeps 03:59 on the previous one (E13)', () => {
    expect(dayAt('2026-10-21T09:00:00Z')).toBe('2026-10-21');
    expect(dayAt('2026-10-21T08:59:00Z')).toBe('2026-10-20');
  });

  it('puts both 1:30 AM readings of 2026-11-01 on business day 2026-10-31', () => {
    expect(dayAt('2026-11-01T06:30:00Z')).toBe('2026-10-31');
    expect(dayAt('2026-11-01T07:30:00Z')).toBe('2026-10-31');
  });

  it.each(Q4_INSTANTS)('reads $iso as its documented Chicago wall clock', (instant) => {
    const { iso: _iso, ...expected } = instant;
    const { year: _year, ...parts } = localParts(at(instant.iso), PROBE_ZONE);
    expect(parts).toEqual(expected);
  });
});

describe('the day start', () => {
  it('defaults a kitchen with no day start to America/Chicago and 04:00 (E14)', () => {
    expect(kitchenSettings({})).toEqual({ timeZone: 'America/Chicago', dayStart: '04:00' });
  });

  it.each(['01:00', '02:30', '02:59'])('refuses %s, an hour a US clock change repeats or skips', (clock) => {
    expect(validateDayStart(clock)).toBe(false);
  });

  it.each(['00:59', '03:00', '04:00'])('accepts %s', (clock) => {
    expect(validateDayStart(clock)).toBe(true);
  });

  it.each(['4:00', '24:00', '12:60', '', 'noon'])('refuses the malformed day start %j', (clock) => {
    expect(validateDayStart(clock)).toBe(false);
  });

  it('throws for a kitchen whose day start is refused and still defaults one given none', () => {
    expect(() => kitchenSettings({ dayStart: '02:30' })).toThrow(/day start/);
    expect(kitchenSettings({})).toEqual({ timeZone: 'America/Chicago', dayStart: '04:00' });
  });

  it('refuses a kitchen profile with a refused day start at load', () => {
    expect(KitchenProfileSchema.safeParse(demoJson).success).toBe(true);
    expect(KitchenProfileSchema.safeParse({ ...demoJson, dayStart: '02:30' }).success).toBe(false);
  });
});

// A zone Intl does not know throws at the first reading of a shift, so it is refused where the
// kitchen's settings load, the way a refused day start is.
describe('the time zone', () => {
  it.each(['America/Chicagoo', 'Mars/Olympus_Mons', 'Central Time', ''])(
    'refuses a kitchen profile naming the unknown zone %j at load',
    (timeZone) => {
      expect(KitchenProfileSchema.safeParse({ ...demoJson, timeZone }).success).toBe(false);
    },
  );

  it('throws for kitchen settings naming an unknown zone', () => {
    expect(() => kitchenSettings({ timeZone: 'America/Chicagoo' })).toThrow(/time zone/);
  });

  it.each(['Europe/Amsterdam', 'UTC'])('accepts a kitchen in the real zone %s', (timeZone) => {
    expect(KitchenProfileSchema.safeParse({ ...demoJson, timeZone }).success).toBe(true);
    expect(kitchenSettings({ timeZone })).toEqual({ timeZone, dayStart: '04:00' });
  });
});

describe('the printed line time', () => {
  it.each([
    ['2026-11-01T06:30:00Z', '1:30 AM CDT'],
    ['2026-11-01T07:30:00Z', '1:30 AM CST'],
    ['2026-03-08T07:59:00Z', '1:59 AM CST'],
    ['2026-03-08T08:00:00Z', '3:00 AM CDT'],
  ])('labels %s within an hour of a clock change as %s', (iso, label) => {
    expect(lineTimeLabel(at(iso), PROBE_ZONE)).toBe(label);
  });

  it.each([
    ['2026-10-20T17:00:00Z', '12:00 PM'],
    ['2026-10-21T04:30:00Z', '11:30 PM'],
    ['2026-11-01T10:00:00Z', '4:00 AM'],
  ])('prints %s as %s with no zone away from a change', (iso, label) => {
    expect(lineTimeLabel(at(iso), PROBE_ZONE)).toBe(label);
  });
});

describe('the record code', () => {
  it('writes the business day as YYMMDD and the line number in three digits', () => {
    expect(recordCode('2026-10-20', 14)).toBe('261020-014');
    expect(recordCode('2026-01-05', 1)).toBe('260105-001');
  });
});

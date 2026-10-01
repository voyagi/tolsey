import { describe, expect, it } from 'vitest';
import demoJson from '../../data/kitchens/demo.json';
import rulesJson from '../../data/rules/food-code-2022.json';
import { KitchenProfileSchema, RuleTableSchema, type TemperatureRow } from './rule';
import { needsDigitRepeat, twinOf, twinRuleFires } from './twins';

const table = RuleTableSchema.parse(rulesJson);
const profile = KitchenProfileSchema.parse(demoJson);

function temperatureRow(id: string): TemperatureRow {
  const row = table.rows.find((candidate) => candidate.id === id);
  if (row?.kind !== 'temperature') throw new Error(`no temperature row ${id}`);
  return row;
}

const TENTHS = 10;
const HIGHEST_TENTHS = 2120;

function everyTenth(): number[] {
  return Array.from({ length: HIGHEST_TENTHS + 1 }, (_, index) => index);
}

function firingDegrees(row: TemperatureRow): number[] {
  return everyTenth()
    .filter((tenths) => twinRuleFires(tenths, row))
    .map((tenths) => tenths / TENTHS);
}

const PAIRS: [number, number][] = [
  [13, 30], [14, 40], [15, 50], [16, 60], [17, 70], [18, 80], [19, 90],
  [113, 130], [114, 140], [115, 150], [116, 160], [117, 170], [118, 180], [119, 190],
];

describe('twinOf', () => {
  it.each(PAIRS)('maps %d and %d onto each other', (teen, ten) => {
    expect(twinOf(teen * TENTHS)).toBe(ten * TENTHS);
    expect(twinOf(ten * TENTHS)).toBe(teen * TENTHS);
  });

  it('has a twin for exactly those 28 whole-degree readings between 0.0 and 212.0 and for nothing else', () => {
    const paired = new Set(PAIRS.flat().map((degrees) => degrees * TENTHS));
    const withTwin = everyTenth().filter((tenths) => twinOf(tenths) !== undefined);
    expect(withTwin).toHaveLength(28);
    expect(new Set(withTwin)).toEqual(paired);
  });

  it('gives no twin to a reading with tenths or below zero', () => {
    expect(twinOf(151)).toBeUndefined();
    expect(twinOf(-150)).toBeUndefined();
  });
});

describe('the exact set the twin rule fires on, over every tenth from 0.0 to 212.0', () => {
  it('fires on cold holding for 15 to 19 only', () => {
    expect(firingDegrees(temperatureRow('cold_holding'))).toEqual([15, 16, 17, 18, 19]);
  });

  it('fires on hot holding for the round readings 140 to 190 only', () => {
    expect(firingDegrees(temperatureRow('hot_holding'))).toEqual([140, 150, 160, 170, 180, 190]);
  });

  it('fires on the roast row for 130 to 190, since 130 passes it while 113 fails it', () => {
    expect(firingDegrees(temperatureRow('hot_holding_roast'))).toEqual([130, 140, 150, 160, 170, 180, 190]);
  });

  it('fires on twelve distinct readings across the three rows', () => {
    const rows = ['cold_holding', 'hot_holding', 'hot_holding_roast'].map(temperatureRow);
    expect(new Set(rows.flatMap(firingDegrees)).size).toBe(12);
  });

  it.each([38, 39, 40, 128, 168])('never fires on %d for any temperature row', (degrees) => {
    for (const row of table.rows) {
      if (row.kind === 'temperature') expect(twinRuleFires(degrees * TENTHS, row)).toBe(false);
    }
  });
});

describe('needsDigitRepeat', () => {
  const coldHolding = temperatureRow('unit_air_cold');
  const coldBand = profile.coarseBands.cold;
  if (coldBand === undefined) throw new Error('the demo profile has no cold coarse band');

  it('holds walk-in 15, whose twin 50 would fail', () => {
    expect(needsDigitRepeat(150, coldHolding, coldBand)).toBe(true);
  });

  it('holds walk-in 13, below the cold band, though its twin 30 would pass too', () => {
    expect(twinRuleFires(130, coldHolding)).toBe(false);
    expect(needsDigitRepeat(130, coldHolding, coldBand)).toBe(true);
  });

  it('holds a reading above the cold band', () => {
    expect(needsDigitRepeat(700, coldHolding, coldBand)).toBe(true);
  });

  it.each([380, 390, 400, 450])('judges %d tenths at the walk-in without a repeat', (tenths) => {
    expect(needsDigitRepeat(tenths, coldHolding, coldBand)).toBe(false);
  });

  it('judges a reading on either edge of the cold band without a repeat', () => {
    expect(needsDigitRepeat(coldBand.lowF * TENTHS, coldHolding, coldBand)).toBe(false);
    expect(needsDigitRepeat(coldBand.highF * TENTHS, coldHolding, coldBand)).toBe(false);
  });
});

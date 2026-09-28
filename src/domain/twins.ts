import { passes, type Limit } from './judge';

// A spoken teen and its ten ("fifteen" and "fifty", "one fifteen" and "one fifty") are the numbers
// most often misheard for each other. The upper family is the lower one a hundred degrees up, so its
// bounds are derived here rather than written out.
const TEEN_FIRST = 13;
const TEEN_LAST = 19;
const TEN = 10;
const FAMILY_OFFSETS = [0, TEN * TEN];

export interface CoarseBand {
  lowF: number;
  highF: number;
}

function twinWithinFamily(degrees: number): number | undefined {
  if (degrees >= TEEN_FIRST && degrees <= TEEN_LAST) return (degrees - TEN) * TEN;
  const digit = degrees / TEN;
  if (Number.isInteger(digit) && digit >= TEEN_FIRST - TEN && digit <= TEEN_LAST - TEN) return TEN + digit;
  return undefined;
}

// Only a whole-degree reading has a twin: nobody says "fifteen point four" and is heard as fifty.
export function twinOf(valueTenths: number): number | undefined {
  if (valueTenths % TEN !== 0) return undefined;
  const degrees = valueTenths / TEN;
  for (const offset of FAMILY_OFFSETS) {
    const twin = twinWithinFamily(degrees - offset);
    if (twin !== undefined) return (twin + offset) * TEN;
  }
  return undefined;
}

// The misheard number only matters when it would flip the verdict to a pass: a reading that passes
// while its twin fails could be a failing reading logged as a pass (READ-07).
export function twinRuleFires(valueTenths: number, row: Limit): boolean {
  const twin = twinOf(valueTenths);
  if (twin === undefined) return false;
  return passes(valueTenths, row.limitFTenths, row.comparator) && !passes(twin, row.limitFTenths, row.comparator);
}

export function needsDigitRepeat(valueTenths: number, row: Limit, band: CoarseBand): boolean {
  if (twinRuleFires(valueTenths, row)) return true;
  return valueTenths < band.lowF * TEN || valueTenths > band.highF * TEN;
}

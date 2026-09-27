import type { Comparator } from './rule';

export type Judgement = 'in_range' | 'out_of_range';

export interface Limit {
  comparator: Comparator;
  limitFTenths: number;
}

// Inclusive both ways, as the Code words it: "41°F or less", "135°F or above".
export function passes(valueTenths: number, limitTenths: number, comparator: Comparator): boolean {
  return comparator === 'at_most' ? valueTenths <= limitTenths : valueTenths >= limitTenths;
}

export function judgeReading(valueTenths: number, limit: Limit): Judgement {
  return passes(valueTenths, limit.limitFTenths, limit.comparator) ? 'in_range' : 'out_of_range';
}

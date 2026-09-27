import type { D1Like, RowsPerWrite } from '../store/port';
import type { StoreLimits } from './data';

export interface SweepRound {
  kitchensDeleted: number;
  rowsCounted: number;
}

export interface SweepRun {
  rounds: number;
  kitchensDeleted: number;
}

export const DELETE_EXPIRED_KITCHENS = '';
export const DELETE_EXPIRED_EVENTS = '';

export async function expireKitchens(
  _db: D1Like,
  _now: number,
  _limits: StoreLimits,
  _rowsPerWrite: RowsPerWrite,
  _roundSize: number,
): Promise<SweepRound> {
  return { kitchensDeleted: 0, rowsCounted: 0 };
}

export async function runScheduledSweep(
  _db: D1Like,
  _now: number,
  _limits: StoreLimits,
  _rowsPerWrite: RowsPerWrite,
): Promise<SweepRun> {
  return { rounds: 0, kitchensDeleted: 0 };
}

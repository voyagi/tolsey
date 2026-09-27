import type { D1Like } from '../store/port';

const SELECT_BUDGET = `SELECT rows FROM budget WHERE utc_date = ?1`;

// No cap check: retention must never be refused, and it spends the same daily allowance as a write.
const ADD_TO_BUDGET = `
INSERT INTO budget (utc_date, rows) VALUES (?1, ?2)
ON CONFLICT (utc_date) DO UPDATE SET rows = rows + excluded.rows`;

// The allowance resets at 00:00 UTC, so the budget is keyed by the instant's UTC date, never by a
// kitchen's business day.
export function utcDate(instantMs: number): string {
  return new Date(instantMs).toISOString().slice(0, 10);
}

export async function readBudgetRows(db: D1Like, date: string): Promise<number> {
  const row = await db.prepare(SELECT_BUDGET).bind(date).first<{ rows: number }>();
  return row?.rows ?? 0;
}

export async function addToBudget(db: D1Like, date: string, rows: number): Promise<void> {
  await db.prepare(ADD_TO_BUDGET).bind(date, rows).run();
}

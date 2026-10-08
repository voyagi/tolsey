import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { D1Like } from '../store/port';
import { HOUR_MS, insertLines, insertScratchKitchens, readLimits } from '../test-support/events';
import { builtWorkerHarness } from '../test-support/target';

const MINUTE_MS = 60_000;
const LINES_EACH = 3;
// 16:00 UTC on 2026-10-21: the hourly Cron Trigger's own instant.
const SCHEDULED_AT = Date.UTC(2026, 9, 21, 16, 0);
const SCHEDULED_DATE = '2026-10-21';

describe('the hourly retention sweep in the built Worker (workerd)', () => {
  let harness: ReturnType<typeof builtWorkerHarness>;
  let db: D1Like;

  beforeAll(async () => {
    harness = builtWorkerHarness();
    await harness.listen();
    const worker = harness.getWorker<{ DB: D1Like }>();
    await worker.applyD1Migrations('DB');
    db = (await worker.getEnv()).DB;
  });

  afterAll(async () => {
    await harness?.close();
  });

  async function count(query: string, ...values: unknown[]): Promise<number> {
    return (await db.prepare(query).bind(...values).first<{ n: number }>())?.n ?? -1;
  }

  async function budgetRows(): Promise<number> {
    return (await db.prepare('SELECT rows FROM budget WHERE utc_date = ?1').bind(SCHEDULED_DATE).first<{ rows: number }>())?.rows ?? 0;
  }

  it('deletes kitchens at retention age and at 24 hours with all their lines, keeps a younger one and the demo row, and counts the deletes (E29)', async () => {
    const retentionAge = readLimits().retentionAgeHours * HOUR_MS;
    const ages = [retentionAge - MINUTE_MS, retentionAge, 24 * HOUR_MS];
    const [young, atRetention, atDay] = await insertScratchKitchens(
      db,
      ages.map((age) => SCHEDULED_AT - age),
    );
    for (const [index, id] of [young, atRetention, atDay].entries()) {
      await insertLines(db, id, LINES_EACH, SCHEDULED_AT - ages[index] + MINUTE_MS);
    }
    const before = await budgetRows();

    const result = await harness.getWorker().scheduled({ cron: '0 * * * *', scheduledTime: new Date(SCHEDULED_AT) });

    expect(result.outcome).toBe('ok');
    for (const gone of [atRetention, atDay]) {
      expect(await count('SELECT COUNT(*) AS n FROM kitchens WHERE id = ?1', gone)).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM events WHERE kitchen_id = ?1', gone)).toBe(0);
    }
    expect(await count('SELECT COUNT(*) AS n FROM kitchens WHERE id = ?1', young)).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM events WHERE kitchen_id = ?1', young)).toBe(LINES_EACH);
    expect(await count("SELECT COUNT(*) AS n FROM kitchens WHERE id = 'demo'")).toBe(1);
    // At least one row per deleted kitchen and line; budget.test.ts pins the exact sum, budget_add included.
    expect((await budgetRows()) - before).toBeGreaterThanOrEqual(2 * (1 + LINES_EACH));
  });
});

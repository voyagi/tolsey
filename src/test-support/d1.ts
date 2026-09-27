import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPlatformProxy, unstable_splitSqlQuery } from 'wrangler';
import type { D1Like } from '../store/port';

export interface TestD1 {
  db: D1Like;
  env: Record<string, unknown>;
  dispose: () => Promise<void>;
}

const MIGRATIONS_DIR = 'migrations';

// db.exec on a whole migration file fails on its comment lines, and a split on semicolons breaks
// trigger bodies, so each file goes through wrangler's own splitter and lands as one batch.
async function applyMigrations(db: D1Like): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const statements = unstable_splitSqlQuery(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    await db.batch(statements.map((statement) => db.prepare(statement)));
  }
}

export async function openTestD1(configPath = 'wrangler.jsonc'): Promise<TestD1> {
  const proxy = await getPlatformProxy<{ DB?: D1Like }>({ configPath, persist: false, remoteBindings: false });
  const db = proxy.env.DB;
  // A missing binding throws rather than skipping: a store suite that skips reads as green.
  if (!db) {
    await proxy.dispose();
    throw new Error(
      `No D1 binding named DB in ${configPath}. The store suite refuses to run without it: ` +
        'add the d1_databases entry with binding "DB" to wrangler.jsonc.',
    );
  }
  await applyMigrations(db);
  return { db, env: proxy.env, dispose: proxy.dispose };
}

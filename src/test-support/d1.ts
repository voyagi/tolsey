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
// trigger bodies, so each file goes through wrangler's own splitter.
export function migrationStatements(file: string): string[] {
  return unstable_splitSqlQuery(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
}

async function applyMigrations(db: D1Like): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const file of files) {
    await db.batch(migrationStatements(file).map((statement) => db.prepare(statement)));
  }
}

// Every row of the four tables in a fixed order, serialized, so two dumps compare as strings.
export async function dumpRecordTables(db: D1Like): Promise<string> {
  const rows = async (query: string) => (await db.prepare(query).all()).results;
  return JSON.stringify({
    events: await rows('SELECT * FROM events ORDER BY seq'),
    kitchens: await rows('SELECT * FROM kitchens ORDER BY id'),
    budget: await rows('SELECT * FROM budget ORDER BY utc_date'),
    kitchenLines: await rows('SELECT * FROM kitchen_lines ORDER BY kitchen_id'),
  });
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

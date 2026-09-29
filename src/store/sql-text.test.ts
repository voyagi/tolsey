import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ADAPTER = 'src/store/d1-store.ts';

// READ-03: the record is append-only, so no statement the adapter prepares may edit or remove an
// events row, in any of the shapes SQL offers for it. The budget upsert targets another table.
const FORBIDDEN: Record<string, RegExp> = {
  update: /\bUPDATE\s+events\b/i,
  delete: /\bDELETE\s+FROM\s+events\b/i,
  replace: /(?<!\bOR\s)\bREPLACE\s+INTO\s+events\b/i,
  insert_or_replace: /\bINSERT\s+OR\s+REPLACE\s+INTO\s+events\b/i,
  upsert: /\bINSERT\s+INTO\s+events\b[\s\S]*\bON\s+CONFLICT\b[\s\S]*\bDO\s+UPDATE\b/i,
};

// One planted statement per shape: a check reworded until it misses its own shape fails here.
const PLANTED: Record<string, string> = {
  update: "UPDATE events SET words = 'edited' WHERE id = ?1",
  delete: 'DELETE FROM events WHERE id = ?1',
  replace: 'REPLACE INTO events (id, words) VALUES (?1, ?2)',
  insert_or_replace: 'INSERT OR REPLACE INTO events (id, words) VALUES (?1, ?2)',
  upsert: 'INSERT INTO events (id, words) VALUES (?1, ?2) ON CONFLICT (id) DO UPDATE SET words = excluded.words',
};

const ALLOWED = [
  'INSERT INTO budget (utc_date, rows) SELECT ?1, ?2 WHERE changes() > 0 ON CONFLICT (utc_date) DO UPDATE SET rows = rows + excluded.rows',
  'INSERT INTO events (id, words) SELECT ?1, ?2 WHERE 1',
  'SELECT * FROM events WHERE words = ?1',
];

function forbiddenShapes(sql: string): string[] {
  return Object.entries(FORBIDDEN)
    .filter(([, pattern]) => pattern.test(sql))
    .map(([shape]) => shape);
}

// Every argument the adapter hands to prepare: a named constant, resolved to its template text, or a
// string written in place. An argument that resolves to nothing fails the test rather than going
// unread.
function preparedSql(source: string): string[] {
  const constants = new Map(
    [...source.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*`([^`]*)`/g)].map((match) => [match[1], match[2]]),
  );
  return [...source.matchAll(/\.prepare\(\s*([^)]*?)\s*\)/g)].map((match) => {
    const argument = match[1];
    const quoted = /^(['"`])([\s\S]*)\1$/.exec(argument);
    if (quoted) return quoted[2];
    const sql = constants.get(argument);
    if (sql === undefined) throw new Error(`prepare(${argument}) in ${ADAPTER} names no SQL constant this test can read`);
    return sql;
  });
}

describe('the D1 adapter SQL, read as text', () => {
  it.each(Object.keys(PLANTED))('catches the planted %s statement by its own shape', (shape) => {
    expect(forbiddenShapes(PLANTED[shape])).toContain(shape);
  });

  it.each(ALLOWED)('lets "%s" through', (sql) => {
    expect(forbiddenShapes(sql)).toEqual([]);
  });

  it('prepares no statement that edits or removes an events row', () => {
    const statements = preparedSql(readFileSync(ADAPTER, 'utf8'));

    expect(statements.length).toBeGreaterThanOrEqual(10);
    expect(statements.flatMap((sql) => forbiddenShapes(sql).map((shape) => `${shape}: ${sql.trim().slice(0, 80)}`))).toEqual([]);
  });

  it('reads every prepared statement, the append insert and the budget upsert among them', () => {
    const statements = preparedSql(readFileSync(ADAPTER, 'utf8'));

    expect(statements.some((sql) => /INSERT INTO events/.test(sql))).toBe(true);
    expect(statements.some((sql) => /INSERT INTO budget[\s\S]*DO UPDATE/.test(sql))).toBe(true);
  });
});

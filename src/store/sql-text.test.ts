import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ADAPTER = 'src/store/d1-store.ts';

// READ-03: the record is append-only, so no statement the adapter prepares may edit or remove an
// events row, in any of the shapes SQL offers for it. The budget upsert targets another table.
const FORBIDDEN: Record<string, RegExp> = {
  update: /\bUPDATE\s+(OR\s+\w+\s+)?events\b/i,
  delete: /\bDELETE\s+FROM\s+events\b/i,
  replace: /(?<!\bOR\s)\bREPLACE\s+INTO\s+events\b/i,
  insert_or_replace: /\bINSERT\s+OR\s+REPLACE\s+INTO\s+events\b/i,
  upsert: /\bINSERT\s+(OR\s+\w+\s+)?INTO\s+events\b[\s\S]*\bON\s+CONFLICT\b[\s\S]*\bDO\s+UPDATE\b/i,
  drop: /\bDROP\s+TABLE\s+(IF\s+EXISTS\s+)?events\b/i,
};

// Comments, identifier quotes and a schema name are taken out before matching, so "main"."events",
// [events] and UPDATE /* note */ events read as the plain spelling the patterns look for.
function plainSpelling(sql: string): string {
  return sql
    .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ')
    .replace(/["`[\]]/g, '')
    .replace(/\b(main|temp)\s*\./gi, '');
}

// Planted statements, each with the shape it must be caught as: a check reworded until it misses
// one of these spellings fails here.
const PLANTED: [string, string][] = [
  ['update', "UPDATE events SET words = 'edited' WHERE id = ?1"],
  ['update', "UPDATE OR IGNORE events SET words = 'edited' WHERE id = ?1"],
  ['update', "UPDATE main.events SET words = 'edited' WHERE id = ?1"],
  ['update', "UPDATE /* note */ \"events\" SET words = 'edited' WHERE id = ?1"],
  ['delete', 'DELETE FROM events WHERE id = ?1'],
  ['delete', 'DELETE FROM [events] WHERE id = ?1'],
  ['delete', 'DELETE FROM "main"."events" WHERE id = ?1'],
  ['replace', 'REPLACE INTO events (id, words) VALUES (?1, ?2)'],
  ['insert_or_replace', 'INSERT OR REPLACE INTO `events` (id, words) VALUES (?1, ?2)'],
  ['upsert', 'INSERT INTO events (id, words) VALUES (?1, ?2) ON CONFLICT (id) DO UPDATE SET words = excluded.words'],
  ['upsert', 'INSERT OR IGNORE INTO events (id, words) VALUES (?1, ?2) ON CONFLICT (id) DO UPDATE SET words = excluded.words'],
  ['drop', 'DROP TABLE IF EXISTS events'],
];

const ALLOWED = [
  'INSERT INTO budget (utc_date, rows) SELECT ?1, ?2 WHERE changes() > 0 ON CONFLICT (utc_date) DO UPDATE SET rows = rows + excluded.rows',
  'INSERT INTO events (id, words) SELECT ?1, ?2 WHERE 1',
  'SELECT * FROM events WHERE words = ?1',
];

function forbiddenShapes(sql: string): string[] {
  const plain = plainSpelling(sql);
  return Object.entries(FORBIDDEN)
    .filter(([, pattern]) => pattern.test(plain))
    .map(([shape]) => shape);
}

// T-01-48: every value is bound, so a statement is fixed text. The lint rule sees only a template or
// a concatenation written inside prepare(...); a named constant built with ${} is caught here.
function interpolates(sql: string): boolean {
  return sql.includes('${');
}

// Every argument the adapter hands to prepare: a named constant, resolved to its template text, or a
// string written in place. A constant counts only when its template ends the statement, so one with a
// value joined on after it resolves to nothing, and an argument that resolves to nothing fails the
// test rather than going unread.
function preparedSql(source: string): string[] {
  const constants = new Map(
    [...source.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*`([^`]*)`\s*;/g)].map((match) => [match[1], match[2]]),
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
  it.each(PLANTED)('catches the planted %s statement "%s" by its own shape', (shape, sql) => {
    expect(forbiddenShapes(sql)).toContain(shape);
  });

  it('reads a named constant built with ${} as interpolated, and a fixed one as not', () => {
    const planted = 'const PLANTED_SQL = `SELECT * FROM events WHERE words = \'${words}\'`;\nthis.db.prepare(PLANTED_SQL);';
    const fixed = 'const FIXED_SQL = `SELECT * FROM events WHERE words = ?1`;\nthis.db.prepare(FIXED_SQL);';

    expect(preparedSql(planted).map(interpolates)).toEqual([true]);
    expect(preparedSql(fixed).map(interpolates)).toEqual([false]);
  });

  // A constant whose template is only the start of its statement, with a value joined on after it, is
  // no fixed text either: it must fail to resolve rather than read as its first part.
  it.each([
    'const JOINED_SQL = `SELECT * FROM events WHERE words = ` + words;\nthis.db.prepare(JOINED_SQL);',
    'const JOINED_SQL = `SELECT * FROM events WHERE words = `.concat(words);\nthis.db.prepare(JOINED_SQL);',
  ])('refuses to read a constant with a value joined onto its template: %s', (planted) => {
    expect(() => preparedSql(planted)).toThrow(/names no SQL constant/);
  });

  it('prepares every statement from fixed text, with no value interpolated into it', () => {
    const statements = preparedSql(readFileSync(ADAPTER, 'utf8'));

    expect(statements.filter(interpolates)).toEqual([]);
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

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ADAPTER = 'src/store/d1-store.ts';
const RETENTION = 'src/server/retention.ts';
const PRODUCT_ROOT = 'src';
// Test support prepares whatever SQL a fixture needs, and the Worker never imports it.
const TEST_SUPPORT = 'src/test-support/';

// READ-03: the record is append-only, so no statement the product prepares may edit or remove an
// events row, in any of the shapes SQL offers for it, or take away what enforces that: a trigger, an
// index or a column. The budget upsert targets another table. The one delete is the retention sweep's,
// of an expired kitchen's whole record, which migration 0002 allows only once the kitchen row is gone.
const FORBIDDEN: Record<string, RegExp> = {
  update: /\bUPDATE\s+(OR\s+\w+\s+)?events\b/i,
  delete: /\bDELETE\s+FROM\s+events\b/i,
  replace: /(?<!\bOR\s)\bREPLACE\s+INTO\s+events\b/i,
  insert_or_replace: /\bINSERT\s+OR\s+REPLACE\s+INTO\s+events\b/i,
  upsert: /\bINSERT\s+(OR\s+\w+\s+)?INTO\s+events\b[\s\S]*\bON\s+CONFLICT\b[\s\S]*\bDO\s+UPDATE\b/i,
  drop: /\bDROP\s+TABLE\s+(IF\s+EXISTS\s+)?events\b/i,
  alter: /\bALTER\s+TABLE\s+events\b/i,
  drop_trigger: /\bDROP\s+TRIGGER\b/i,
  drop_index: /\bDROP\s+INDEX\b/i,
};

// The retention sweep's delete, the one statement allowed a forbidden shape, named so that nothing
// else can borrow the exception.
const RETENTION_DELETE = { file: RETENTION, argument: 'DELETE_EXPIRED_EVENTS', shape: 'delete' };

// Comments, identifier quotes and any schema name before events are taken out before matching, so
// "main"."events", arch.events, [events] and UPDATE /* note */ events read as the plain spelling.
function plainSpelling(sql: string): string {
  return sql
    .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ')
    .replace(/["`[\]]/g, '')
    .replace(/\b\w+\s*\.\s*(?=events\b)/gi, '');
}

// Planted statements, each with the shape it must be caught as: a check reworded until it misses
// one of these spellings fails here.
const PLANTED: [string, string][] = [
  ['update', "UPDATE events SET words = 'edited' WHERE id = ?1"],
  ['update', "UPDATE OR IGNORE events SET words = 'edited' WHERE id = ?1"],
  ['update', "UPDATE main.events SET words = 'edited' WHERE id = ?1"],
  ['update', "UPDATE arch.events SET words = 'edited' WHERE id = ?1"],
  ['update', "UPDATE /* note */ \"events\" SET words = 'edited' WHERE id = ?1"],
  ['delete', 'DELETE FROM events WHERE id = ?1'],
  ['delete', 'DELETE FROM [events] WHERE id = ?1'],
  ['delete', 'DELETE FROM "main"."events" WHERE id = ?1'],
  ['replace', 'REPLACE INTO events (id, words) VALUES (?1, ?2)'],
  ['replace', 'REPLACE INTO arch.events (id, words) VALUES (?1, ?2)'],
  ['insert_or_replace', 'INSERT OR REPLACE INTO `events` (id, words) VALUES (?1, ?2)'],
  ['upsert', 'INSERT INTO events (id, words) VALUES (?1, ?2) ON CONFLICT (id) DO UPDATE SET words = excluded.words'],
  ['upsert', 'INSERT OR IGNORE INTO events (id, words) VALUES (?1, ?2) ON CONFLICT (id) DO UPDATE SET words = excluded.words'],
  ['drop', 'DROP TABLE IF EXISTS events'],
  ['alter', 'ALTER TABLE events DROP COLUMN words'],
  ['alter', 'ALTER TABLE main.events RENAME TO old_events'],
  ['drop_trigger', 'DROP TRIGGER events_no_update'],
  ['drop_trigger', 'DROP TRIGGER IF EXISTS main.events_no_delete'],
  ['drop_index', 'DROP INDEX events_supersedes'],
];

const ALLOWED = [
  'INSERT INTO budget (utc_date, rows) SELECT ?1, ?2 WHERE changes() > 0 ON CONFLICT (utc_date) DO UPDATE SET rows = rows + excluded.rows',
  'INSERT INTO events (id, words) SELECT ?1, ?2 WHERE 1',
  'SELECT * FROM events WHERE words = ?1',
  'SELECT said_wrong.id FROM events AS said_wrong WHERE said_wrong.kitchen_id = ?1',
];

function forbiddenShapes(sql: string): string[] {
  const plain = plainSpelling(sql);
  return Object.entries(FORBIDDEN)
    .filter(([, pattern]) => pattern.test(plain))
    .map(([shape]) => shape);
}

// T-01-48: every value is bound, so a statement is fixed text. The lint rule sees only a template or
// a concatenation written inside prepare(...); a named constant built with ${}, or any argument that is
// not a fixed constant at all (a variable, a join, a helper's result), is caught here.
function interpolates(sql: string): boolean {
  return sql.includes('${');
}

interface Prepared {
  argument: string;
  sql: string;
}

// Every argument a file hands to prepare: a named constant, resolved to its template text, or a string
// written in place. A constant counts only when its template ends the statement, so one with a value
// joined on after it resolves to nothing, and an argument that resolves to nothing fails the test
// rather than going unread.
function preparedStatements(source: string, file = ADAPTER): Prepared[] {
  const constants = new Map(
    [...source.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*`([^`]*)`\s*;/g)].map((match) => [match[1], match[2]]),
  );
  return [...source.matchAll(/\.prepare\(\s*([^)]*?)\s*\)/g)].map((match) => {
    const argument = match[1];
    const quoted = /^(['"`])([\s\S]*)\1$/.exec(argument);
    if (quoted) return { argument, sql: quoted[2] };
    const sql = constants.get(argument);
    if (sql === undefined) throw new Error(`prepare(${argument}) in ${file} names no SQL constant this test can read`);
    return { argument, sql };
  });
}

function preparedSql(source: string): string[] {
  return preparedStatements(source).map((statement) => statement.sql);
}

// Every product file that hands SQL to prepare, found by reading all of src rather than a list, so a
// new file that prepares a statement is read the day it lands, in a new folder too.
function productSqlFiles(): string[] {
  return readdirSync(PRODUCT_ROOT, { recursive: true, encoding: 'utf8' })
    .map((entry) => `${PRODUCT_ROOT}/${entry.replaceAll('\\', '/')}`)
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.endsWith('.d.ts'))
    .filter((file) => !file.startsWith(TEST_SUPPORT))
    .filter((file) => readFileSync(file, 'utf8').includes('.prepare('))
    .sort();
}

function productStatements(): (Prepared & { file: string })[] {
  return productSqlFiles().flatMap((file) =>
    preparedStatements(readFileSync(file, 'utf8'), file).map((statement) => ({ ...statement, file })),
  );
}

function isRetentionDelete(file: string, argument: string, shape: string): boolean {
  return file === RETENTION_DELETE.file && argument === RETENTION_DELETE.argument && shape === RETENTION_DELETE.shape;
}

describe('the D1 SQL the product prepares, read as text', () => {
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
  // no fixed text either: it must fail to resolve rather than read as its first part. So must any
  // argument that is not a constant: a variable, a join or a tagged template.
  it.each([
    'const JOINED_SQL = `SELECT * FROM events WHERE words = ` + words;\nthis.db.prepare(JOINED_SQL);',
    'const JOINED_SQL = `SELECT * FROM events WHERE words = `.concat(words);\nthis.db.prepare(JOINED_SQL);',
    'const sql = buildSelect(words);\ndb.prepare(sql);',
    "db.prepare(parts.join(''));",
    'db.prepare(sqlTag`SELECT * FROM events WHERE words = ${words}`);',
  ])('refuses to read a statement that is not a fixed constant: %s', (planted) => {
    expect(() => preparedSql(planted)).toThrow(/names no SQL constant/);
  });

  it('finds every product file that prepares SQL, the adapter, the budget and the retention sweep among them', () => {
    expect(productSqlFiles()).toEqual(expect.arrayContaining([ADAPTER, 'src/server/budget.ts', RETENTION]));
  });

  it('prepares every statement from fixed text, with no value interpolated into it', () => {
    const statements = productStatements();

    expect(statements.filter((statement) => statement.file === ADAPTER).length).toBeGreaterThanOrEqual(10);
    expect(statements.filter((statement) => interpolates(statement.sql)).map((statement) => statement.argument)).toEqual([]);
  });

  it.each(ALLOWED)('lets "%s" through', (sql) => {
    expect(forbiddenShapes(sql)).toEqual([]);
  });

  it('prepares no statement that edits or removes an events row, apart from the retention sweep', () => {
    const found = productStatements().flatMap(({ file, argument, sql }) =>
      forbiddenShapes(sql).map((shape) => ({ file, argument, shape })),
    );

    expect(found.filter(({ file, argument, shape }) => !isRetentionDelete(file, argument, shape))).toEqual([]);
    expect(found).toEqual([RETENTION_DELETE]);
  });

  it('reads every prepared statement, the append insert and the budget upsert among them', () => {
    const statements = preparedSql(readFileSync(ADAPTER, 'utf8'));

    expect(statements.some((sql) => /INSERT INTO events/.test(sql))).toBe(true);
    expect(statements.some((sql) => /INSERT INTO budget[\s\S]*DO UPDATE/.test(sql))).toBe(true);
  });
});

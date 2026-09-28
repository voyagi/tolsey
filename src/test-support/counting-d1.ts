import type { D1Like, D1ResultLike, D1StatementLike } from '../store/port';

interface CountedStatement {
  query: string;
  via: 'run' | 'all' | 'first' | 'batch';
}

export interface CountingD1 {
  db: D1Like;
  statements: CountedStatement[];
  batches: { queries: string[]; results: D1ResultLike[] }[];
  totals(): { rowsRead: number; rowsWritten: number };
}

interface CountedStatementLike extends D1StatementLike {
  inner: D1StatementLike;
  query: string;
}

type AnswerAll = (query: string) => Record<string, unknown>[] | undefined;

const ANSWERED_META = { changes: 0, rows_written: 0, rows_read: 0, last_row_id: 0 };

// Every statement the code under test runs is recorded with its query, and every result's rows read
// and written are summed. first() is served through all() so its meta is seen too. A result with no
// meta.rows_read fails loudly: counting it as zero would pass a test that measured nothing.
export function countingD1(inner: D1Like, answerAll?: AnswerAll): CountingD1 {
  const statements: CountedStatement[] = [];
  const batches: CountingD1['batches'] = [];
  const results: D1ResultLike[] = [];

  const record = (query: string, result: D1ResultLike) => {
    if (typeof result.meta?.rows_read !== 'number') {
      throw new Error(`a D1 result carried no meta.rows_read, so its reads cannot be counted: ${query.trim()}`);
    }
    results.push(result);
  };

  const statement = (source: D1StatementLike, query: string): CountedStatementLike => ({
    inner: source,
    query,
    bind: (...values) => statement(source.bind(...values), query),
    all: async <Row>() => {
      statements.push({ query, via: 'all' });
      const answered = answerAll?.(query);
      const result = answered
        ? ({ results: answered, meta: ANSWERED_META } as unknown as D1ResultLike<Row>)
        : await source.all<Row>();
      record(query, result as D1ResultLike);
      return result;
    },
    first: async <Row>() => {
      statements.push({ query, via: 'first' });
      const result = await source.all<Row>();
      record(query, result as D1ResultLike);
      return result.results[0] ?? null;
    },
    run: async <Row>() => {
      statements.push({ query, via: 'run' });
      const result = await source.run<Row>();
      record(query, result as D1ResultLike);
      return result;
    },
  });

  const db: D1Like = {
    prepare: (query) => statement(inner.prepare(query), query),
    batch: async <Row>(batch: D1StatementLike[]) => {
      const counted = batch as CountedStatementLike[];
      for (const each of counted) statements.push({ query: each.query, via: 'batch' });
      const batchResults = await inner.batch<Row>(counted.map((each) => each.inner));
      counted.forEach((each, index) => record(each.query, batchResults[index] as D1ResultLike));
      batches.push({ queries: counted.map((each) => each.query), results: batchResults as D1ResultLike[] });
      return batchResults;
    },
  };

  return {
    db,
    statements,
    batches,
    totals: () => ({
      rowsRead: results.reduce((sum, result) => sum + result.meta.rows_read, 0),
      rowsWritten: results.reduce((sum, result) => sum + result.meta.rows_written, 0),
    }),
  };
}

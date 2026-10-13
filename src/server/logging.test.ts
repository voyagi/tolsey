import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { D1Store } from '../store/d1-store';
import type { D1Like, KitchenRow, ScreenEvent, Store } from '../store/port';
import { openTestD1, type TestD1 } from '../test-support/d1';
import { byId, errorById, postJsonRpc, sendRaw } from '../test-support/raw-mcp';
import { createWorker, type WorkerEnv } from './worker';

const KITCHEN_ID = 'fedcba9876543210fedcba9876543210';
const WORDS = 'the walk-in reads 38 behind the fish crate';
const INITIALS = 'KL';
const FIXED_SENTENCE = 'Tolsey could not log that. Try again.';
const CONSOLE_METHODS = ['error', 'warn', 'log', 'info', 'debug'] as const;
const NO_ROWS = { changes: 0, rows_read: 0, rows_written: 0, last_row_id: 0 };

const SCRATCH: KitchenRow = {
  id: KITCHEN_ID,
  kind: 'scratch',
  label: null,
  timeZone: 'America/Chicago',
  dayStart: '04:00',
  createdAt: Date.UTC(2026, 9, 20, 14, 0),
};

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  _meta?: Record<string, unknown>;
}

function carryingWords(where: string, words = WORDS): Error {
  const error = new Error(`${where} failed on "${words}" by ${INITIALS}`);
  (error as Error & { code: string }).code = 'STORE_DOWN';
  return error;
}

// A database that refuses every query, as D1 does once the account reaches its daily limits. Preparing
// and binding a statement never reach the database (prepare is synchronous), so they succeed here as they
// do there, and the refusal comes when a statement or a batch runs. Each statement it was asked to
// prepare, and each batch, is recorded.
function refusingDb(asked: string[] = []): D1Like {
  const refuse = async () => {
    throw carryingWords('a query');
  };
  return {
    prepare: (query: string) => {
      asked.push(query);
      const statement = { bind: () => statement, first: refuse, all: refuse, run: refuse };
      return statement;
    },
    batch: async () => {
      asked.push('batch');
      throw carryingWords('a batch');
    },
  };
}

function storeWith(overrides: Partial<Store>): Store {
  return {
    createKitchen: async () => {
      throw new Error('createKitchen is not part of this case');
    },
    findKitchen: async () => SCRATCH,
    append: async () => {
      throw new Error('append is not part of this case');
    },
    linesForDay: async () => [],
    findByRequest: async () => null,
    ...overrides,
  } as Store;
}

describe('what a fault leaves in the logs and the reply', () => {
  let d1: TestD1;
  let spies: MockInstance[];

  beforeAll(async () => {
    d1 = await openTestD1();
  });

  afterAll(async () => {
    await d1?.dispose();
  });

  beforeEach(() => {
    spies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function logged(): string {
    return JSON.stringify(spies.map((spy) => spy.mock.calls));
  }

  function errorCalls(): unknown[][] {
    return spies[0].mock.calls;
  }

  function fetchAsLocalhost(worker: ReturnType<typeof createWorker>, env: WorkerEnv) {
    return (url: string | URL, init?: RequestInit) => {
      const request = new Request(url, init);
      const headers = new Headers(request.headers);
      headers.set('host', 'localhost');
      return worker.fetch(new Request(request, { headers }), env);
    };
  }

  function workerFor(store: Store) {
    const worker = createWorker({ clock: { now: () => Date.UTC(2026, 9, 20, 15, 0) }, storeFor: () => store });
    const env: WorkerEnv = {
      ASSETS: { fetch: async () => new Response('asset') },
      ALLOWED_HOSTNAMES: 'localhost',
      DB: d1.db,
    };
    return { fetchWith: fetchAsLocalhost(worker, env) };
  }

  async function callWalkIn(
    fetchWith: (url: string | URL, init?: RequestInit) => Promise<Response>,
    words = WORDS,
    value = 38,
  ) {
    const client = new Client({ name: 'logging-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://localhost/mcp/k/${KITCHEN_ID}`), { fetch: fetchWith }),
    );
    try {
      return (await client.callTool({
        name: 'log_reading',
        arguments: {
          check_point: 'walk_in',
          value,
          measured: 'air',
          words,
          initials: INITIALS,
          screen_id: 'logging-wall',
          request_id: crypto.randomUUID(),
        },
      })) as ToolResult;
    } finally {
      await client.close();
    }
  }

  function expectNameAndCodeOnly(prefix: string): void {
    const call = errorCalls().find((args) => args[0] === prefix);
    expect(call, `no console.error call starting with ${prefix}: ${logged()}`).toBeDefined();
    expect(Object.keys(call?.[1] as object).sort()).toEqual(['code', 'name']);
  }

  it('answers a store fault inside log_reading with the fixed sentence and logs neither the words, the initials nor the message', async () => {
    const { fetchWith } = workerFor(storeWith({ append: async () => { throw carryingWords('append'); } }));
    const result = await callWalkIn(fetchWith);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: FIXED_SENTENCE }]);
    expect(result._meta).toEqual({ error: 'server_fault' });
    expect(logged()).not.toContain(WORDS);
    expect(logged()).not.toContain(INITIALS);
    expect(logged()).not.toContain('failed on');
    expect(errorCalls()).toContainEqual(['[log_reading]', { name: 'Error', code: 'STORE_DOWN' }]);
  });

  // A thrown value that is no Error has no name to log, and its text is the very thing that may
  // carry the words, so its type stands in for the name.
  it('logs a thrown string by its type alone, with none of its text', async () => {
    const thrown = `append failed on "${WORDS}" by ${INITIALS}`;
    const { fetchWith } = workerFor(storeWith({ append: async () => { throw thrown; } }));
    const result = await callWalkIn(fetchWith);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: FIXED_SENTENCE }]);
    expect(errorCalls()).toContainEqual(['[log_reading]', { name: 'string', code: undefined }]);
    expectNameAndCodeOnly('[log_reading]');
    expect(logged()).not.toContain(WORDS);
    expect(logged()).not.toContain(INITIALS);
    expect(logged()).not.toContain('failed on');
  });

  it('logs a thrown plain object by its type and its code, never its message', async () => {
    const thrown = { code: 'STORE_DOWN', message: `findKitchen failed on "${WORDS}" by ${INITIALS}` };
    const { fetchWith } = workerFor(storeWith({ findKitchen: async () => { throw thrown; } }));
    const response = await sendRaw(
      { url: new URL(`http://localhost/mcp/k/${KITCHEN_ID}`), fetch: fetchWith },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      },
    );

    expect(response.status).toBe(500);
    expect(errorCalls()).toContainEqual(['[worker]', { name: 'object', code: 'STORE_DOWN' }]);
    expect(logged()).not.toContain(WORDS);
    expect(logged()).not.toContain('failed on');
  });

  it('logs a text/plain POST through onerror as an object with only its name and code', async () => {
    const { fetchWith } = workerFor(storeWith({}));
    const response = await sendRaw(
      { url: new URL(`http://localhost/mcp/k/${KITCHEN_ID}`), fetch: fetchWith },
      {
        method: 'POST',
        headers: { 'content-type': 'text/plain', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      },
    );

    expect(response.status).toBe(415);
    expectNameAndCodeOnly('[mcp]');
    expect(logged()).not.toContain('Unsupported Media Type');
  });

  it('answers a scope lookup fault with a JSON-RPC 500 of code -32603 and logs name and code only', async () => {
    const { fetchWith } = workerFor(storeWith({ findKitchen: async () => { throw carryingWords('findKitchen'); } }));
    const response = await sendRaw(
      { url: new URL(`http://localhost/mcp/k/${KITCHEN_ID}`), fetch: fetchWith },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      },
    );

    expect(response.status).toBe(500);
    expect(response.contentType).toMatch(/^application\/json/);
    expect(errorById(response, null)).toEqual({ code: -32603, message: 'Internal error' });
    expect(response.bodyText).not.toContain(WORDS);
    expectNameAndCodeOnly('[worker]');
    expect(logged()).not.toContain(WORDS);
    expect(logged()).not.toContain(INITIALS);
  });

  it('answers a mint fault with a JSON 500 server_error and logs name and code only', async () => {
    const { fetchWith } = workerFor(storeWith({ createKitchen: async () => { throw carryingWords('createKitchen'); } }));
    const response = await fetchWith('http://localhost/api/kitchens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await response.json()).toEqual({ error: 'server_error' });
    expectNameAndCodeOnly('[worker]');
    expect(logged()).not.toContain(WORDS);
    expect(logged()).not.toContain(INITIALS);
  });

  it('fails the hourly retention run with the fixed error and logs name and code only', async () => {
    const worker = createWorker({ clock: { now: () => 0 } });
    const env: WorkerEnv = { ASSETS: { fetch: async () => new Response('asset') }, ALLOWED_HOSTNAMES: 'localhost', DB: refusingDb() };

    const run = worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 21, 12, 0), cron: '0 * * * *' }, env);

    await expect(run).rejects.toThrow(/^the retention sweep failed$/);
    expectNameAndCodeOnly('[retention]');
    expect(errorCalls()).toContainEqual(['[retention]', { name: 'Error', code: 'STORE_DOWN' }]);
    expect(logged()).not.toContain('failed on');
  });

  // Past the account's D1 limits no query runs, and docs/DEPLOYMENT.md says where that surfaces: the
  // Worker's own adapter over a refusing database fails at the kitchen lookup and the mint's budget
  // read, before any tool, while nothing the demo kitchen does asks the database for anything.
  it('answers a database that refuses every query with 500s for a scratch kitchen and a mint, and the demo still answers', async () => {
    const asked: string[] = [];
    const worker = createWorker({ clock: { now: () => Date.UTC(2026, 9, 20, 15, 0) } });
    const env: WorkerEnv = { ASSETS: { fetch: async () => new Response('asset') }, ALLOWED_HOSTNAMES: 'localhost', DB: refusingDb(asked) };
    const fetchWith = fetchAsLocalhost(worker, env);
    const walkIn = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'log_reading',
        arguments: { check_point: 'walk_in', value: 38, initials: INITIALS, screen_id: 'limit-wall', request_id: crypto.randomUUID() },
      },
    };

    const demo = byId(await postJsonRpc({ url: new URL('http://localhost/mcp'), fetch: fetchWith }, walkIn), 1) as ToolResult;
    expect(demo._meta).toEqual({ error: 'demo_read_only' });
    expect(asked).toEqual([]);

    const scratch = await postJsonRpc({ url: new URL(`http://localhost/mcp/k/${KITCHEN_ID}`), fetch: fetchWith }, walkIn);
    expect(scratch.status).toBe(500);
    expect(errorById(scratch, null)).toEqual({ code: -32603, message: 'Internal error' });

    const mint = await fetchWith('http://localhost/api/kitchens', { method: 'POST' });
    expect(mint.status).toBe(500);
    expect(await mint.json()).toEqual({ error: 'server_error' });

    // Both lines carry the refusal's own code, so neither 500 came from a method the double lacks.
    expect(asked.length).toBeGreaterThan(0);
    expect(errorCalls()).toEqual([
      ['[worker]', { name: 'Error', code: 'STORE_DOWN' }],
      ['[worker]', { name: 'Error', code: 'STORE_DOWN' }],
    ]);
    expect(logged()).not.toContain('failed on');
  });

  // A deliberate throw is named, so the log tells it apart from any other Error with no message read.
  it('logs the empty follow-up read after a refused append by its own name', async () => {
    const empty: D1Like = {
      prepare: () => {
        const statement = {
          bind: () => statement,
          first: async () => null,
          all: async () => ({ results: [], meta: NO_ROWS }),
          run: async () => ({ results: [], meta: NO_ROWS }),
        };
        return statement;
      },
      batch: async (statements) => statements.map(() => ({ results: [], meta: NO_ROWS })),
    };
    const { fetchWith } = workerFor(storeWith({ append: (input) => new D1Store(empty).append(input) }));
    const result = await callWalkIn(fetchWith);

    expect(result.content).toEqual([{ type: 'text', text: FIXED_SENTENCE }]);
    expect(errorCalls()).toContainEqual(['[log_reading]', { name: 'MissingFollowUpRow', code: undefined }]);
  });

  it('logs a check point missing from the kitchen profile by its own name, never the id', async () => {
    const vanished: ScreenEvent = {
      id: 'line-1',
      kind: 'reading',
      occurredAt: Date.UTC(2026, 9, 20, 14, 59),
      checkPointId: 'retired_cooler_by_KL',
      measured: 'air',
      valueTenths: 380,
      promptKind: null,
      expiresAt: null,
      answered: false,
      corrections: 0,
    };
    const { fetchWith } = workerFor(storeWith({ latestByScreen: async () => vanished }));
    const result = await callWalkIn(fetchWith, 'wrong number');

    expect(result.content).toEqual([{ type: 'text', text: FIXED_SENTENCE }]);
    expect(errorCalls()).toContainEqual(['[log_reading]', { name: 'UnknownCheckPoint', code: undefined }]);
    expect(logged()).not.toContain('retired_cooler');
  });

  // The mint's own sweep round is best effort and the hourly run is not, so each logs under its own
  // prefix and a failed mint round never reads as a failed hourly run.
  it('logs a failed sweep round on a mint under its own prefix, name and code only, and still mints', async () => {
    const sweepFails: D1Like = {
      prepare: (query) => {
        if (query.includes('SELECT id FROM kitchens')) throw carryingWords('the mint sweep');
        return d1.db.prepare(query);
      },
      batch: (statements) => d1.db.batch(statements),
    };
    const worker = createWorker({ clock: { now: () => Date.UTC(2026, 9, 20, 15, 0) } });
    const env: WorkerEnv = { ASSETS: { fetch: async () => new Response('asset') }, ALLOWED_HOSTNAMES: 'localhost', DB: sweepFails };
    const response = await worker.fetch(new Request('http://localhost/api/kitchens', { method: 'POST', headers: { host: 'localhost' } }), env);

    expect(response.status).toBe(201);
    expect(errorCalls()).toContainEqual(['[mint-sweep]', { name: 'Error', code: 'STORE_DOWN' }]);
    expect(errorCalls().map((args) => args[0])).not.toContain('[retention]');
    expect(logged()).not.toContain('failed on');
  });

  // Each call's words must survive the rebuild to reach the store, so each carries its own value:
  // phrases the rebuild drops would make every assertion below pass with the message logged.
  it('keeps the rule for ten concurrent failing calls, each carrying its own words', async () => {
    const seen: string[] = [];
    const { fetchWith } = workerFor(
      storeWith({
        append: async (input) => {
          seen.push(input.event.words);
          throw carryingWords('append', input.event.words);
        },
      }),
    );
    const values = Array.from({ length: 10 }, (_, index) => 31 + index);
    const phrases = values.map((value) => `the walk-in reads ${value}`);
    const results = await Promise.all(values.map((value, index) => callWalkIn(fetchWith, phrases[index], value)));

    expect([...seen].sort()).toEqual([...phrases].sort());
    expect(results.map((result) => result.content[0]?.text)).toEqual(phrases.map(() => FIXED_SENTENCE));
    for (const phrase of phrases) expect(logged()).not.toContain(phrase);
    expect(logged()).not.toContain(INITIALS);
    expect(logged()).not.toContain('failed on');
  });
});

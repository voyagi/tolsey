import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { D1Like, KitchenRow, Store } from '../store/port';
import { openTestD1, type TestD1 } from '../test-support/d1';
import { errorById, sendRaw } from '../test-support/raw-mcp';
import { createWorker, type WorkerEnv } from './worker';

const KITCHEN_ID = 'fedcba9876543210fedcba9876543210';
const WORDS = 'the walk-in reads 38 behind the fish crate';
const INITIALS = 'KL';
const FIXED_SENTENCE = 'Tolsey could not log that. Try again.';
const CONSOLE_METHODS = ['error', 'warn', 'log', 'info', 'debug'] as const;

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

  function workerFor(store: Store) {
    const worker = createWorker({ clock: { now: () => Date.UTC(2026, 9, 20, 15, 0) }, storeFor: () => store });
    const env: WorkerEnv = {
      ASSETS: { fetch: async () => new Response('asset') },
      ALLOWED_HOSTNAMES: 'localhost',
      DB: d1.db,
    };
    const fetchWith = (url: string | URL, init?: RequestInit) => {
      const request = new Request(url, init);
      const headers = new Headers(request.headers);
      headers.set('host', 'localhost');
      return worker.fetch(new Request(request, { headers }), env);
    };
    return { fetchWith };
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
    const failingDb = {
      prepare: () => {
        throw carryingWords('the sweep');
      },
      batch: async () => {
        throw carryingWords('the sweep');
      },
    } as unknown as D1Like;
    const env: WorkerEnv = { ASSETS: { fetch: async () => new Response('asset') }, ALLOWED_HOSTNAMES: 'localhost', DB: failingDb };

    const run = worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 21, 12, 0), cron: '0 * * * *' }, env);

    await expect(run).rejects.toThrow(/^the retention sweep failed$/);
    expectNameAndCodeOnly('[retention]');
    expect(errorCalls()).toContainEqual(['[retention]', { name: 'Error', code: 'STORE_DOWN' }]);
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

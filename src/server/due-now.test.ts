import { createMcpHandler } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DueNowOutputSchema } from '../contract/due-now';
import { D1Store } from '../store/d1-store';
import type { Store } from '../store/port';
import { countingStore, type CountingStore } from '../test-support/counting-store';
import { openTestD1, type TestD1 } from '../test-support/d1';
import { callDueNow, callLogReading, walkInArguments, type ToolResult } from '../test-support/mcp-client';
import { byId, postJsonRpc } from '../test-support/raw-mcp';
import { LOCAL_HOSTNAMES, mintThroughRoute, type FetchLike } from '../test-support/target';
import { DEMO_PROFILE, ROWS_PER_WRITE, RULES, RULES_VERSION, STORE_LIMITS } from './data';
import { createServer, type ServerDeps } from './mcp';
import { createWorker, type WorkerEnv } from './worker';

const BASE = new URL('http://localhost/');
const AFTERNOON = Date.parse('2026-10-20T19:00:00Z');
// 23:30 in Chicago on the 20th, already the 21st in UTC: the day must come from the kitchen's clock.
const LATE_EVENING = Date.parse('2026-10-21T04:30:00Z');
const NO_CHECKS_OPEN = 'No checks are open.';

interface OpenCheck {
  id: string;
  name: string;
}

function openChecksOf(result: ToolResult): OpenCheck[] {
  expect(result.isError).toBeFalsy();
  return (result.structuredContent as { openChecks: OpenCheck[] }).openChecks;
}

describe('due_now, the checks still open today', () => {
  let d1: TestD1;
  let counting: CountingStore;
  let instant = AFTERNOON;
  const worker = createWorker({ clock: { now: () => instant }, storeFor: () => counting.store });

  beforeAll(async () => {
    d1 = await openTestD1();
    counting = countingStore(new D1Store(d1.db));
  });

  afterAll(async () => {
    await d1?.dispose();
  });

  const env = (): WorkerEnv => ({
    ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
    ALLOWED_HOSTNAMES: LOCAL_HOSTNAMES,
    DB: d1.db,
  });

  // A Node Request built from a URL carries no Host header, and the SDK answers 403 without one.
  const local: FetchLike = async (url, init) => {
    const request = new Request(url, init);
    const headers = new Headers(request.headers);
    headers.set('host', new URL(String(url)).host);
    return worker.fetch(new Request(request, { headers }), env());
  };

  async function kitchen(): Promise<URL> {
    instant = AFTERNOON;
    const { mcpPath } = await mintThroughRoute(local, BASE);
    return new URL(mcpPath, BASE);
  }

  async function say(at: URL, overrides: Record<string, unknown>): Promise<ToolResult> {
    return callLogReading(local, at, walkInArguments({ measured: undefined, ...overrides }));
  }

  function refuse(at: URL, checkPoint: string, words: string): Promise<ToolResult> {
    return say(at, { check_point: checkPoint, value: undefined, words });
  }

  async function dueNowCallsOf(at: URL): Promise<{ result: ToolResult; calls: string[] }> {
    const before = counting.calls.length;
    const result = await callDueNow(local, at);
    return { result, calls: counting.calls.slice(before) };
  }

  it('lists reach-in two by name after a numberless call for it', async () => {
    const at = await kitchen();
    expect((await refuse(at, 'reach_in_2', 'reach-in two is fine')).structuredContent).toMatchObject({ outcome: 'refused' });

    const result = await callDueNow(local, at);

    expect(openChecksOf(result)).toEqual([{ id: 'reach_in_2', name: 'Reach-in two' }]);
    expect(result.content[0]?.text).toBe('Open checks: Reach-in two.');
  });

  it('drops reach-in two once a number for it is logged', async () => {
    const at = await kitchen();
    await refuse(at, 'reach_in_2', 'reach-in two is fine');
    const logged = await say(at, { check_point: 'reach_in_2', value: 38, words: 'reach-in two reads 38' });
    expect(logged.structuredContent).toMatchObject({ outcome: 'in_range' });

    const result = await callDueNow(local, at);

    expect(openChecksOf(result)).toEqual([]);
    expect(result.content[0]?.text).toBe(NO_CHECKS_OPEN);
  });

  it('keeps the walk-in listed while its reading waits for a digit repeat', async () => {
    const at = await kitchen();
    const held = await say(at, { check_point: 'walk_in', value: 15, words: 'walk-in 15' });
    expect(held.structuredContent).toMatchObject({ outcome: 'held', prompt: { kind: 'digit_repeat' } });

    expect(openChecksOf(await callDueNow(local, at))).toEqual([{ id: 'walk_in', name: 'Walk-in' }]);
  });

  // The store orders by id, and the soup well is refused first, so only the profile's order puts the
  // walk-in ahead of it.
  it('lists open checks in the profile order, never by id or by the time they were refused', async () => {
    const at = await kitchen();
    await refuse(at, 'soup_well', 'the soup well is fine');
    await refuse(at, 'walk_in', 'the walk-in is fine');

    const result = await callDueNow(local, at);

    expect(openChecksOf(result).map((check) => check.id)).toEqual(['walk_in', 'soup_well']);
    expect(result.content[0]?.text).toBe('Open checks: Walk-in, Soup well.');
  });

  it('answers an empty list and says so for a kitchen with nothing open', async () => {
    const result = await callDueNow(local, await kitchen());

    expect(openChecksOf(result)).toEqual([]);
    expect(result.content[0]?.text).toBe(NO_CHECKS_OPEN);
  });

  it("never lists a check refused in another kitchen", async () => {
    const other = await kitchen();
    const at = await kitchen();
    await refuse(other, 'reach_in_2', 'reach-in two is fine');

    expect(openChecksOf(await callDueNow(local, other))).toHaveLength(1);
    expect(openChecksOf(await callDueNow(local, at))).toEqual([]);
  });

  it("carries contract version 1, the kitchen's business day for the clock read and its time zone", async () => {
    const at = await kitchen();
    instant = LATE_EVENING;
    await refuse(at, 'freezer', 'the freezer is fine');

    const result = await callDueNow(local, at);

    expect(DueNowOutputSchema.parse(result.structuredContent)).toEqual({
      contractVersion: 1,
      businessDay: '2026-10-20',
      timeZone: 'America/Chicago',
      openChecks: [{ id: 'freezer', name: 'Freezer' }],
    });
  });

  it('lists due_now with an empty input object and an output object refusing additional properties', async () => {
    const at = await kitchen();
    const response = await postJsonRpc({ url: at, fetch: local }, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const { tools } = byId(response, 1) as { tools: { name: string; inputSchema: unknown; outputSchema: unknown }[] };
    const dueNow = tools.find((tool) => tool.name === 'due_now');

    expect(dueNow?.inputSchema).toMatchObject({ type: 'object', properties: {}, additionalProperties: false });
    expect(dueNow?.outputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['contractVersion', 'businessDay', 'timeZone', 'openChecks'],
    });
  });

  // MCP lets a host leave arguments out of tools/call; an empty-input tool must still answer it.
  it('answers a tools/call that carries no arguments member at all', async () => {
    const at = await kitchen();
    const response = await postJsonRpc(
      { url: at, fetch: local },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'due_now' } },
    );

    expect(byId(response, 1)).toMatchObject({ structuredContent: { openChecks: [] } });
  });

  it('answers at the demo kitchen without an error and makes no append there', async () => {
    instant = AFTERNOON;
    const { result, calls } = await dueNowCallsOf(new URL('/mcp', BASE));

    expect(openChecksOf(result)).toEqual([]);
    expect(calls).toContain('openChecks');
    expect(calls).not.toContain('append');
  });

  it('reads a scratch kitchen with open checks and makes no append there', async () => {
    const at = await kitchen();
    await refuse(at, 'reach_in_2', 'reach-in two is fine');

    const { result, calls } = await dueNowCallsOf(at);

    expect(openChecksOf(result)).toHaveLength(1);
    expect(calls).toContain('openChecks');
    expect(calls.filter((call) => call !== 'findKitchen' && call !== 'openChecks')).toEqual([]);
  });
});

describe('the due_now fault path', () => {
  const PLANTED = 'D1_ERROR near reach-in two for AB';

  const failingStore: Store = {
    createKitchen: async () => ({ status: 'created' }),
    findKitchen: async () => null,
    linesForDay: async () => [],
    openChecks: async () => {
      throw Object.assign(new Error(PLANTED), { code: 'SQLITE_ERROR' });
    },
    pendingPrompt: async () => null,
    latestByScreen: async () => null,
    findByRequest: async () => null,
    append: async () => ({ status: 'refused', reason: 'kitchen_closed' }),
  };

  const deps: ServerDeps = {
    store: failingStore,
    clock: { now: () => AFTERNOON },
    kitchen: { id: 'k', kind: 'scratch', label: null, timeZone: 'America/Chicago', dayStart: '04:00', createdAt: 0 },
    rules: RULES,
    rulesVersion: RULES_VERSION,
    profile: DEMO_PROFILE,
    limits: STORE_LIMITS,
    rowsPerWrite: ROWS_PER_WRITE,
  };

  it('answers a thrown store error with its own fixed server_fault sentence and logs only its name and code', async () => {
    const handler = createMcpHandler(() => createServer(deps));
    const viaHandler: FetchLike = async (url, init) => {
      const request = new Request(url, init);
      const headers = new Headers(request.headers);
      headers.set('host', 'localhost');
      return handler.fetch(new Request(request, { headers }));
    };
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    let result: ToolResult;
    try {
      result = await callDueNow(viaHandler, new URL('/mcp', BASE));
    } finally {
      console.error = original;
    }

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Tolsey could not read the open checks. Try again.' }],
      _meta: { error: 'server_fault' },
    });
    expect(JSON.stringify(result)).not.toContain(PLANTED);
    expect(logged).toEqual([['[due_now]', { name: 'Error', code: 'SQLITE_ERROR' }]]);
  });
});

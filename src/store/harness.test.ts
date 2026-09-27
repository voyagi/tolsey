import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import demoJson from '../../data/kitchens/demo.json';
import { openTestD1, type TestD1 } from '../test-support/d1';
import { D1Store } from './d1-store';
import type { NewEvent } from './port';

const KITCHEN_CREATED_AT = Date.UTC(2026, 9, 20, 14, 0, 0);
const CALL_AT = KITCHEN_CREATED_AT + 60_000;
const BUSINESS_DAY = '2026-10-20';
const HOUR_MS = 3_600_000;

const RESULT_TEMPLATE = JSON.stringify({
  content: [{ type: 'text', text: 'Logged the walk-in at 38 degrees.' }],
  structuredContent: { outcome: 'logged' },
});

interface ProbeResult {
  isError?: boolean;
  content: unknown[];
  structuredContent?: { recordCode?: string };
}

function probeEvent(kitchenId: string, requestId: string): NewEvent {
  return {
    id: crypto.randomUUID(),
    kitchenId,
    kind: 'reading',
    occurredAt: CALL_AT,
    businessDay: BUSINESS_DAY,
    timeZone: 'America/Chicago',
    screenId: 'wall',
    requestId,
    origin: 'person',
    checkPointId: 'walk_in',
    measured: 'air',
    initials: 'QX',
    words: 'the walk-in reads 38',
    valueTenths: 380,
    unit: 'F',
    outcome: 'logged',
    verdict: 'pass',
    ruleId: 'cold_holding',
    ruleSnapshot: null,
    rulesVersion: 'test',
    supersedesId: null,
    rootId: null,
    refId: null,
    answersId: null,
    promptKind: null,
    expiresAt: null,
    dueSlotId: null,
    dueAt: null,
    argsHash: 'harness-probe-args',
  };
}

// A fresh McpServer per request: the legacy leg's teardown closes the transport of whichever
// instance it holds, so one shared instance would let one request close another's.
function probeServer(store: D1Store, kitchenId: string): McpServer {
  const server = new McpServer(
    { name: 'harness', version: '1.0.0' },
    { capabilities: { tools: { listChanged: false } } },
  );
  server.registerTool(
    'harness_probe',
    { description: 'Appends one reading through the store.', inputSchema: z.object({ request_id: z.string() }) },
    async ({ request_id }) => {
      const outcome = await store.append({
        event: probeEvent(kitchenId, request_id),
        resultTemplate: RESULT_TEMPLATE,
        expectedRows: 10,
        utcDate: '2026-10-20',
        dailyRowCap: 40_000,
        kitchenLineCap: 200,
        writeWindowMs: 23 * HOUR_MS,
        retryWindowMs: 120_000,
        now: CALL_AT,
      });
      if (outcome.status === 'appended' || outcome.status === 'duplicate') return JSON.parse(outcome.resultJson);
      return { content: [{ type: 'text', text: `not stored: ${outcome.status}` }], isError: true };
    },
  );
  return server;
}

// A Node Request built from a URL carries no Host header, and the SDK answers 403 without one.
function inProcessFetch(handler: { fetch(request: Request): Promise<Response> }) {
  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(url, init);
    const headers = new Headers(request.headers);
    headers.set('host', new URL(String(url)).host);
    return handler.fetch(new Request(request, { headers }));
  };
}

describe('the D1 test harness', () => {
  let d1: TestD1;
  let client: Client;
  const kitchenId = crypto.randomUUID();

  beforeAll(async () => {
    d1 = await openTestD1();
    const store = new D1Store(d1.db);
    await store.createKitchen({
      kitchen: {
        id: kitchenId,
        kind: 'scratch',
        label: null,
        timeZone: 'America/Chicago',
        dayStart: '04:00',
        createdAt: KITCHEN_CREATED_AT,
      },
      expectedRows: 20,
      utcDate: '2026-10-20',
      dailyRowCap: 40_000,
    });
    const handler = createMcpHandler(() => probeServer(store, kitchenId));
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: inProcessFetch(handler),
    });
    client = new Client({ name: 'harness-canary', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
    await d1?.dispose();
  });

  it('appends one events row through a reference client tools call and reads it back directly', async () => {
    const result = (await client.callTool({
      name: 'harness_probe',
      arguments: { request_id: 'canary-1' },
    })) as ProbeResult;

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.recordCode).toMatch(/^\d{6}-001$/);
    const rows = await d1.db
      .prepare('SELECT seq, day_line, result_json FROM events WHERE kitchen_id = ?1 AND request_id = ?2')
      .bind(kitchenId, 'canary-1')
      .all<{ seq: number; day_line: number; result_json: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].day_line).toBe(1);
    expect(rows.results[0].seq).toBeGreaterThan(0);
    const stored = JSON.parse(rows.results[0].result_json) as ProbeResult;
    expect({ content: result.content, structuredContent: result.structuredContent }).toEqual(stored);
  });

  it('returns the first result for a repeated request id and stores no second row', async () => {
    const first = (await client.callTool({ name: 'harness_probe', arguments: { request_id: 'canary-2' } })) as ProbeResult;
    const repeat = (await client.callTool({ name: 'harness_probe', arguments: { request_id: 'canary-2' } })) as ProbeResult;

    expect(first.isError).toBeFalsy();
    expect(repeat).toEqual(first);
    const count = await d1.db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE kitchen_id = ?1 AND request_id = ?2')
      .bind(kitchenId, 'canary-2')
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  // The migration writes the demo kitchen's zone and day start out in SQL, a copy of demo.json's that
  // no import keeps in step, so a change to either shows up here.
  it('seeds the demo kitchen with the zone and day start of the demo profile', async () => {
    const demo = await new D1Store(d1.db).findKitchen('demo');
    expect(demo).toMatchObject({ kind: 'demo', timeZone: demoJson.timeZone, dayStart: demoJson.dayStart });
  });

  it('refuses to open a D1 without the DB binding, naming the binding and wrangler.jsonc', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tolsey-no-binding-'));
    const configPath = join(dir, 'wrangler.jsonc');
    writeFileSync(configPath, JSON.stringify({ name: 'no-binding', compatibility_date: '2026-08-15' }));
    try {
      await expect(openTestD1(configPath)).rejects.toThrow(/binding named DB[\s\S]*wrangler\.jsonc/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

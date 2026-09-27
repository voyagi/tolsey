import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dumpRecordTables } from '../test-support/d1';
import { HOUR_MS, readLimits } from '../test-support/events';
import { callLogReading, walkInArguments } from '../test-support/mcp-client';
import { mintThroughRoute, openInProcessWorker, type InProcessWorker } from '../test-support/target';

// 10:00 CDT on 2026-10-20, inside the demo kitchen's business day of that date.
const MINT_AT = Date.UTC(2026, 9, 20, 15, 0);
const BUSINESS_DAY = '2026-10-20';
const DEMO_READ_ONLY =
  "This is the demo kitchen, and its record is read only. Start your own kitchen to log readings.";

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

interface KitchenRecord {
  kind: string;
  label: string | null;
  time_zone: string;
  day_start: string;
  created_at: number;
}

describe('POST /api/kitchens and the kitchen a visitor writes to', () => {
  let worker: InProcessWorker;

  beforeAll(async () => {
    worker = await openInProcessWorker();
  });

  afterAll(async () => {
    await worker?.dispose();
  });

  beforeEach(() => {
    worker.clock.set(MINT_AT);
  });

  async function callWalkIn(path: string): Promise<ToolResult> {
    const transport = new StreamableHTTPClientTransport(new URL(path, worker.baseUrl), { fetch: worker.fetch });
    const client = new Client({ name: 'endpoint-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    try {
      return (await client.callTool({
        name: 'log_reading',
        arguments: {
          check_point: 'walk_in',
          value: 38,
          measured: 'air',
          words: 'the walk-in reads 38',
          initials: 'AB',
          screen_id: 'endpoint-wall',
          request_id: crypto.randomUUID(),
        },
      })) as ToolResult;
    } finally {
      await client.close();
    }
  }

  async function kitchenRow(id: string): Promise<KitchenRecord | null> {
    return worker.db
      .prepare('SELECT kind, label, time_zone, day_start, created_at FROM kitchens WHERE id = ?1')
      .bind(id)
      .first<KitchenRecord>();
  }

  function post(path: string, body?: string): Promise<Response> {
    return worker.fetch(new URL(path, worker.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body }),
    });
  }

  it('mints a scratch kitchen with a 128-bit id, its path, the instant it is deleted by and the instant it closes', async () => {
    const limits = readLimits();
    const response = await post('/api/kitchens', JSON.stringify({ label: 'conformance' }));

    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    const minted = (await response.json()) as Record<string, unknown>;
    expect(minted.id).toMatch(/^[0-9a-f]{32}$/);
    expect(minted).toEqual({
      id: minted.id,
      mcpPath: `/mcp/k/${String(minted.id)}`,
      // The deletion bound (D-07): retention age, the wait for the next hourly run, and the 15 minutes
      // that run may start late (PRIV-03).
      expiresAt: new Date(MINT_AT + limits.retentionAgeHours * HOUR_MS + HOUR_MS + 15 * 60_000).toISOString(),
      closesAt: new Date(MINT_AT + limits.writeWindowHours * HOUR_MS - limits.retryWindowSeconds * 1000).toISOString(),
    });
    expect(await kitchenRow(String(minted.id))).toEqual({
      kind: 'scratch',
      label: 'conformance',
      time_zone: 'America/Chicago',
      day_start: '04:00',
      created_at: MINT_AT,
    });
  });

  it('mints a kitchen labelled capture with no rights beyond any other scratch kitchen', async () => {
    const minted = await mintThroughRoute(worker.fetch, worker.baseUrl, { label: 'capture' });
    expect(await kitchenRow(minted.id)).toMatchObject({ kind: 'scratch', label: 'capture' });
  });

  it('logs walk-in 38 for AB on the minted kitchen path, and a direct read finds the line', async () => {
    const minted = await mintThroughRoute(worker.fetch, worker.baseUrl);
    const result = await callWalkIn(minted.mcpPath);

    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toEqual({ type: 'text', text: 'Walk-in, 38, in range, AB' });
    const lines = await worker.store.linesForDay(minted.id, BUSINESS_DAY);
    expect(lines.map((line) => [line.id, line.valueTenths, line.initials])).toEqual([
      [result.structuredContent?.lineId, 380, 'AB'],
    ]);
  });

  it('refuses the same call at the bare /mcp demo kitchen with a spoken reason and changes no stored byte', async () => {
    const minted = await mintThroughRoute(worker.fetch, worker.baseUrl);
    const before = await dumpRecordTables(worker.db);

    const refused = await callWalkIn('/mcp');
    const afterDemo = await dumpRecordTables(worker.db);

    expect(refused.isError).toBe(true);
    expect(refused.content[0]).toEqual({ type: 'text', text: DEMO_READ_ONLY });
    expect(afterDemo).toBe(before);

    // The positive control: the same dump does see a write that lands.
    const logged = await callWalkIn(minted.mcpPath);
    expect(logged.isError).toBeFalsy();
    expect(await dumpRecordTables(worker.db)).not.toBe(afterDemo);
  });

  it('answers the same call past the retry window as request_id_expired, naming the first line, and stores nothing new', async () => {
    const limits = readLimits();
    const minted = await mintThroughRoute(worker.fetch, worker.baseUrl);
    const args = walkInArguments();
    const first = await callLogReading(worker.fetch, new URL(minted.mcpPath, worker.baseUrl), args);

    worker.clock.set(MINT_AT + limits.retryWindowSeconds * 1000 + 1);
    const late = (await callLogReading(worker.fetch, new URL(minted.mcpPath, worker.baseUrl), args)) as ToolResult & {
      _meta?: Record<string, unknown>;
    };

    expect(first.structuredContent?.recordCode).toBe('261020-001');
    expect(late.isError).toBe(true);
    expect(late._meta).toEqual({ error: 'request_id_expired' });
    expect(late.content[0]?.text).toBe(
      'Tolsey already logged this call earlier, record 261020-001. Use a new request_id only for a new reading.',
    );
    expect(await worker.store.linesForDay(minted.id, BUSINESS_DAY)).toHaveLength(1);
  });

  it('answers a label outside the closed list with 400 invalid_label and mints nothing', async () => {
    const before = await dumpRecordTables(worker.db);
    const response = await post('/api/kitchens', JSON.stringify({ label: 'admin' }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_label' });
    expect(await dumpRecordTables(worker.db)).toBe(before);
  });

  it('answers GET /api/kitchens with 405 method_not_allowed', async () => {
    const response = await worker.fetch(new URL('/api/kitchens', worker.baseUrl));
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({ error: 'method_not_allowed' });
  });

  it('answers a POST to an unknown /api path with a JSON 404', async () => {
    const response = await post('/api/nothing', '{}');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });
});

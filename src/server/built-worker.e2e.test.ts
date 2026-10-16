import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D1Store } from '../store/d1-store';
import type { D1Like } from '../store/port';
import { appendInput, kitchenInput, readLimits, scratchKitchen, testEvent } from '../test-support/events';
import { BUILT_CONFIG, builtWorkerHarness, mintThroughRoute } from '../test-support/target';

describe('the built Worker in workerd', () => {
  let harness: ReturnType<typeof builtWorkerHarness>;
  let url: URL;
  let db: D1Like;

  beforeAll(async () => {
    harness = builtWorkerHarness();
    ({ url } = await harness.listen());
    const worker = harness.getWorker<{ DB: D1Like }>();
    await worker.applyD1Migrations('DB');
    db = (await worker.getEnv()).DB;
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('negotiates protocol 2025-11-25 with a reference client at /mcp', async () => {
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', url));
    const client = new Client({ name: 'e2e', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    try {
      expect(transport.protocolVersion).toBe('2025-11-25');
    } finally {
      await client.close();
    }
  });

  it('ships an allowlist that names the deployed host and no loopback host', () => {
    const built = JSON.parse(readFileSync(BUILT_CONFIG, 'utf8')) as { vars?: { ALLOWED_HOSTNAMES?: string } };
    expect(built.vars?.ALLOWED_HOSTNAMES).toBe('tolsey.taranity.com');
  });

  const KITCHENS_BODY = JSON.stringify({ label: 'conformance' });
  const BAD_ORIGIN = { origin: 'https://attacker.example' };
  const STREAMING = { accept: 'application/json, text/event-stream' };

  // Local wrangler dev answered the request after a refusal that left its body unread with a 500,
  // "Network connection lost".
  it.each([
    {
      refused: 'a bad-Origin POST /mcp with 403',
      method: 'POST',
      path: '/mcp',
      headers: BAD_ORIGIN,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      status: 403,
    },
    { refused: 'a bad-Origin POST /api/kitchens with 403', method: 'POST', path: '/api/kitchens', headers: BAD_ORIGIN, body: KITCHENS_BODY, status: 403 },
    { refused: 'a PUT /api/kitchens that carries a body', method: 'PUT', path: '/api/kitchens', headers: STREAMING, body: KITCHENS_BODY, status: 405 },
    { refused: 'a DELETE /mcp that carries a body', method: 'DELETE', path: '/mcp', headers: STREAMING, body: KITCHENS_BODY, status: 405 },
  ])('answers the next request normally after refusing $refused', async ({ method, path, headers, body, status }) => {
    const refused = await fetch(new URL(path, url), { method, headers: { 'content-type': 'application/json', ...headers }, body });
    expect(refused.status).toBe(status);
    await refused.body?.cancel();
    const next = await mintThroughRoute(fetch, url);
    expect(next.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('serves the asset page at the root', async () => {
    const response = await fetch(new URL('/', url));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('appends an event through a D1Store over the Worker binding and reads it back', async () => {
    const store = new D1Store(db);
    const kitchen = scratchKitchen();
    await store.createKitchen(kitchenInput(kitchen, readLimits()));
    const event = testEvent(kitchen.id);

    const outcome = await store.append(appendInput(event, readLimits()));
    expect(outcome.status).toBe('appended');
    const lines = await store.linesForDay(kitchen.id, event.businessDay);
    expect(lines.map((line) => [line.id, line.dayLine])).toEqual([[event.id, 1]]);
  });

  it('refuses an UPDATE of an events row through the Worker binding with the trigger', async () => {
    const store = new D1Store(db);
    const kitchen = scratchKitchen();
    await store.createKitchen(kitchenInput(kitchen, readLimits()));
    const event = testEvent(kitchen.id);
    await store.append(appendInput(event, readLimits()));

    await expect(
      db.prepare("UPDATE events SET words = 'edited' WHERE id = ?1").bind(event.id).run(),
    ).rejects.toThrow(/events are append-only/);
  });
});

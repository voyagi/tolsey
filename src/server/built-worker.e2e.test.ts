import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D1Store } from '../store/d1-store';
import type { D1Like } from '../store/port';
import { appendInput, kitchenInput, readLimits, scratchKitchen, testEvent } from '../test-support/events';
import { BUILT_CONFIG, builtWorkerHarness } from '../test-support/target';

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

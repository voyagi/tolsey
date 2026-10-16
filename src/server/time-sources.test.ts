import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { byId, postJsonRpc } from '../test-support/raw-mcp';
import { resolveTarget, type Target } from '../test-support/target';

const CLOCK_AT = Date.parse('2026-10-20T19:00:00Z');
const CLOCK_DAY = '2026-10-20';
const FORGED = '2020-01-01T00:00:00Z';
const FORGED_HTTP_DATE = 'Wed, 01 Jan 2020 00:00:00 GMT';

interface ToolResult {
  isError?: boolean;
  structuredContent?: { lineId?: string; serverTime?: string };
}

interface Vector {
  query: string;
  headers: Record<string, string>;
  extraArguments: Record<string, string>;
}

const NONE: Vector = { query: '', headers: {}, extraArguments: {} };

// READ-06 and N3: the one instant a line carries is the injected clock's, whatever time the
// request itself claims.
const VECTORS: [string, Vector][] = [
  ['tool arguments taken_at, time and occurred_at', { ...NONE, extraArguments: { taken_at: FORGED, time: FORGED, occurred_at: FORGED } }],
  ['a query string now=', { ...NONE, query: `?now=${encodeURIComponent(FORGED)}` }],
  ['an x-now header', { ...NONE, headers: { 'x-now': FORGED } }],
  ['a Date header', { ...NONE, headers: { date: FORGED_HTTP_DATE } }],
  ['a cookie now=', { ...NONE, headers: { cookie: `now=${encodeURIComponent(FORGED)}` } }],
];

describe('no time taken from the request', () => {
  let target: Target;

  beforeAll(async () => {
    target = await resolveTarget('in-process');
  });

  afterAll(async () => {
    await target?.dispose();
  });

  it.each(VECTORS)('stores the injected clock as occurred_at despite %s', async (_label, vector) => {
    target.clock?.set(CLOCK_AT);
    const kitchenId = await target.createKitchen();
    const endpoint = { url: new URL(`/mcp/k/${kitchenId}${vector.query}`, target.baseUrl), fetch: target.fetch };
    const call = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'log_reading',
        arguments: {
          check_point: 'walk_in',
          value: 38,
          initials: 'AB',
          screen_id: 'time-sources',
          request_id: crypto.randomUUID(),
          ...vector.extraArguments,
        },
      },
    };

    const result = byId(await postJsonRpc(endpoint, call, vector.headers), 1) as ToolResult;

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.serverTime).toBe(new Date(CLOCK_AT).toISOString());
    const lines = (await target.readLines?.(kitchenId, CLOCK_DAY)) ?? [];
    expect(lines.map((line) => [line.id, line.occurredAt])).toEqual([[result.structuredContent?.lineId, CLOCK_AT]]);
  });
});

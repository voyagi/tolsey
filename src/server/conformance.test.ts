import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { byId, errorById, postJsonRpc, sendRaw, type Endpoint } from '../test-support/raw-mcp';
import { resolveTarget, type Target } from '../test-support/target';

// 23:30 CDT on 2026-10-20, when the UTC date is already the 21st: a business day read from the
// UTC date instead of the kitchen's wall clock lands on the wrong day.
const CALL_AT = Date.UTC(2026, 9, 21, 4, 30);
const CALL_BUSINESS_DAY = '2026-10-20';
const UI_EXTENSION = 'io.modelcontextprotocol/ui';

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

interface ListedTool {
  name: string;
  outputSchema?: { type?: string; additionalProperties?: unknown };
  annotations?: Record<string, unknown>;
}

type ClientOptions = ConstructorParameters<typeof Client>[1];

function deployedBaseUrl(): URL | undefined {
  if (inject('target') !== 'deployed') return undefined;
  const value = process.env.TOLSEY_MCP_URL;
  if (!value) throw new Error("TOLSEY_MCP_URL is not set: npm run test:deployed needs the deployed Worker's base URL");
  return new URL(value);
}

// An independent reading of the kitchen's day, so the stored business day is checked against
// something other than the code that wrote it.
function chicagoBusinessDay(instant: number): string {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(format.formatToParts(instant).map((part) => [part.type, part.value]));
  const beforeDayStart = Number(parts.hour) < 4;
  const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) - (beforeDayStart ? 1 : 0)));
  return date.toISOString().slice(0, 10);
}

async function connect(target: Target, path: string, options: ClientOptions = { capabilities: {} }): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(path, target.baseUrl),
    target.fetch ? { fetch: target.fetch } : undefined,
  );
  const client = new Client({ name: 'conformance', version: '1.0.0' }, options);
  await client.connect(transport);
  return client;
}

async function withClient<T>(client: Client, use: (client: Client) => Promise<T>): Promise<T> {
  try {
    return await use(client);
  } finally {
    await client.close();
  }
}

function walkInArguments(requestId: string, overrides: Record<string, unknown> = {}) {
  return {
    check_point: 'walk_in',
    value: 38,
    measured: 'air',
    words: 'the walk-in reads 38',
    initials: 'AB',
    screen_id: 'conformance-wall',
    request_id: requestId,
    ...overrides,
  };
}

function walkInCall(requestId: string, overrides: Record<string, unknown> = {}) {
  return { name: 'log_reading', arguments: walkInArguments(requestId, overrides) };
}

function toolsCall(id: string | number, requestId: string) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: walkInCall(requestId) };
}

const TOOLS_LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

function initialize(protocolVersion: string) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'raw-probe', version: '1.0.0' } },
  };
}

describe(`MCP conformance on the ${inject('target')} target`, () => {
  let target: Target;
  let kitchenId: string;
  let endpoint: Endpoint;

  // The days a line written between these instants can land on, read back where storage is readable.
  async function linesBetween(id: string, before: number, after: number) {
    if (!target.readLines) return undefined;
    const days = [...new Set([chicagoBusinessDay(before), chicagoBusinessDay(after)])];
    return (await Promise.all(days.map((day) => target.readLines?.(id, day) ?? []))).flat();
  }

  function now(): number {
    return target.clock?.now() ?? Date.now();
  }

  beforeAll(async () => {
    target = await resolveTarget(inject('target'), deployedBaseUrl());
    target.clock?.set(CALL_AT);
    kitchenId = await target.createKitchen();
    endpoint = { url: new URL(`/mcp/k/${kitchenId}`, target.baseUrl), fetch: target.fetch };
  });

  afterAll(async () => {
    await target?.dispose();
  });

  describe('initialize and capabilities', () => {
    it('initializes a 2025-11-25 client declaring no capabilities in the legacy era', async () => {
      const client = await connect(target, `/mcp/k/${kitchenId}`);
      await withClient(client, async () => {
        expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
        expect(client.getProtocolEra()).toBe('legacy');
      });
    });

    it('initializes a 2025-03-26 client declaring roots in the legacy era', async () => {
      const client = await connect(target, `/mcp/k/${kitchenId}`, {
        capabilities: { roots: { listChanged: true } },
        supportedProtocolVersions: ['2025-03-26'],
      });
      await withClient(client, async () => {
        expect(client.getNegotiatedProtocolVersion()).toBe('2025-03-26');
        expect(client.getProtocolEra()).toBe('legacy');
      });
    });

    it('answers an initialize asking 2025-06-18 at that supported version', async () => {
      const response = await postJsonRpc(endpoint, initialize('2025-06-18'));
      expect(byId(response, 1)).toMatchObject({ protocolVersion: '2025-06-18' });
    });

    it('answers an initialize sent twice with the same result both times', async () => {
      const first = await postJsonRpc(endpoint, initialize('2025-11-25'));
      const second = await postJsonRpc(endpoint, initialize('2025-11-25'));
      expect(byId(second, 1)).toEqual(byId(first, 1));
    });

    it('declares tools.listChanged and resources.listChanged false, and lists no resources', async () => {
      const client = await connect(target, `/mcp/k/${kitchenId}`);
      await withClient(client, async () => {
        const capabilities = client.getServerCapabilities();
        expect(capabilities?.tools?.listChanged).toBe(false);
        expect(capabilities?.resources?.listChanged).toBe(false);
        expect((await client.listResources()).resources).toEqual([]);
      });
    });
  });

  describe('tools/list', () => {
    it('lists exactly the log_reading tool for a client declaring no capabilities', async () => {
      const client = await connect(target, `/mcp/k/${kitchenId}`);
      await withClient(client, async () => {
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name)).toEqual(['log_reading']);
      });
    });

    it('lists exactly the log_reading tool for a client declaring the MCP Apps UI extension', async () => {
      const client = await connect(target, `/mcp/k/${kitchenId}`, {
        capabilities: { extensions: { [UI_EXTENSION]: { mimeTypes: ['text/html;profile=mcp-app'] } } },
      } as ClientOptions);
      await withClient(client, async () => {
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name)).toEqual(['log_reading']);
      });
    });

    it('lists exactly the log_reading tool for a lone POST with no initialize and no MCP-Protocol-Version', async () => {
      const response = await postJsonRpc(endpoint, TOOLS_LIST);
      const { tools } = byId(response, 1) as { tools: ListedTool[] };
      expect(tools.map((tool) => tool.name)).toEqual(['log_reading']);
    });

    it('gives every listed tool an object outputSchema refusing additional properties and the write annotations', async () => {
      const { tools } = byId(await postJsonRpc(endpoint, TOOLS_LIST), 1) as { tools: ListedTool[] };
      for (const tool of tools) {
        expect(tool.outputSchema).toMatchObject({ type: 'object', additionalProperties: false });
        expect(tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
      }
    });

    it('returns the same tools in the same order with deep-equal schemas across sequential and concurrent requests', async () => {
      const first = byId(await postJsonRpc(endpoint, TOOLS_LIST), 1);
      const second = byId(await postJsonRpc(endpoint, TOOLS_LIST), 1);
      const concurrent = await Promise.all([postJsonRpc(endpoint, TOOLS_LIST), postJsonRpc(endpoint, TOOLS_LIST)]);
      expect(second).toEqual(first);
      expect(concurrent.map((response) => byId(response, 1))).toEqual([first, first]);
    });
  });

  describe('transport rules', () => {
    it('answers notifications/initialized with 202 and no body', async () => {
      const response = await postJsonRpc(endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' });
      expect(response.status).toBe(202);
      expect(response.bodyText).toBe('');
    });

    it('refuses MCP-Protocol-Version 1999-01-01 with 400 and a -32000 error', async () => {
      const response = await postJsonRpc(endpoint, TOOLS_LIST, { 'mcp-protocol-version': '1999-01-01' });
      expect(response.status).toBe(400);
      expect(errorById(response, null).code).toBe(-32000);
    });

    it('refuses a POST whose Accept lacks text/event-stream with 406 and a -32000 error', async () => {
      const response = await postJsonRpc(endpoint, TOOLS_LIST, { accept: 'application/json' });
      expect(response.status).toBe(406);
      expect(errorById(response, null).code).toBe(-32000);
    });

    it.each(['GET', 'DELETE'])('refuses %s with 405 and a -32000 error', async (method) => {
      const response = await sendRaw(endpoint, { method, headers: { accept: 'application/json, text/event-stream' } });
      expect(response.status).toBe(405);
      expect(errorById(response, null).code).toBe(-32000);
    });

    it('answers an empty POST body with 400 and a -32700 parse error on id null, never a 500', async () => {
      const response = await postJsonRpc(endpoint, '');
      expect(response.status).toBe(400);
      expect(errorById(response, null).code).toBe(-32700);
    });

    it('answers two concurrent tools/call requests each under its own id', async () => {
      const [first, second] = await Promise.all([
        postJsonRpc(endpoint, toolsCall('call-a', crypto.randomUUID())),
        postJsonRpc(endpoint, toolsCall('call-b', crypto.randomUUID())),
      ]);
      const a = byId(first, 'call-a') as ToolResult;
      const b = byId(second, 'call-b') as ToolResult;
      expect(a.isError).toBeFalsy();
      expect(b.isError).toBeFalsy();
      expect(a.structuredContent?.lineId).not.toBe(b.structuredContent?.lineId);
    });
  });

  describe('log_reading', () => {
    it('logs walk-in 38 for AB, reads it back in range, and stores every field of the line', async () => {
      const client = await connect(target, `/mcp/k/${kitchenId}`);
      const before = now();
      const result = (await withClient(client, (c) => c.callTool(walkInCall(crypto.randomUUID())))) as ToolResult;
      const after = now();

      expect(result.isError).toBeFalsy();
      expect(result.content[0]).toEqual({ type: 'text', text: 'Walk-in, 38, in range, AB' });
      expect(result.structuredContent).toMatchObject({ contractVersion: 1, outcome: 'in_range' });

      const lines = (await linesBetween(kitchenId, before, after))?.filter(
        (line) => line.id === result.structuredContent?.lineId,
      );
      if (!lines) return;
      expect(lines).toHaveLength(1);
      const [line] = lines;
      expect(line).toMatchObject({
        kind: 'reading',
        valueTenths: 380,
        unit: 'F',
        initials: 'AB',
        checkPointId: 'walk_in',
        measured: 'air',
        words: 'the walk-in reads 38',
        origin: 'person',
        ruleId: 'unit_air_cold',
        timeZone: 'America/Chicago',
      });
      expect(JSON.parse(line.ruleSnapshot ?? 'null')).toMatchObject({ id: 'unit_air_cold' });
      expect(line.rulesVersion).toMatch(/\S/);
      expect(line.businessDay).toBe(chicagoBusinessDay(line.occurredAt));
      if (target.clock) {
        expect(line.occurredAt).toBe(CALL_AT);
        expect(line.businessDay).toBe(CALL_BUSINESS_DAY);
      } else {
        expect(line.occurredAt).toBeGreaterThanOrEqual(before);
        expect(line.occurredAt).toBeLessThanOrEqual(after);
      }
    });

    it.each([
      ['a value that is not a number', { value: 'x' }, /value/],
      ['words of 201 characters', { words: 'a'.repeat(201) }, /words/],
      ['the near-miss check point walk_ins', { check_point: 'walk_ins' }, /check_point/],
      ['a value with two decimal places', { value: 38.55 }, /one decimal place/],
      ['a value past any thermometer', { value: 1e300 }, /value/],
    ])('answers %s with isError true and stores nothing', async (_label, overrides, named) => {
      const freshKitchen = await target.createKitchen();
      const client = await connect(target, `/mcp/k/${freshKitchen}`);
      const before = now();
      const result = (await withClient(client, (c) =>
        c.callTool(walkInCall(crypto.randomUUID(), overrides)),
      )) as ToolResult;
      const after = now();

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(named);
      const lines = await linesBetween(freshKitchen, before, after);
      if (lines) expect(lines).toEqual([]);
    });

    it('stores two readings given at the same instant, ordered by sequence', async () => {
      const freshKitchen = await target.createKitchen();
      const client = await connect(target, `/mcp/k/${freshKitchen}`);
      const before = now();
      const results = (await withClient(client, async (c) => [
        await c.callTool(walkInCall(crypto.randomUUID())),
        await c.callTool(walkInCall(crypto.randomUUID(), { value: 39, words: 'the walk-in reads 39' })),
      ])) as ToolResult[];
      const after = now();

      expect(results.map((result) => Boolean(result.isError))).toEqual([false, false]);
      const lines = await linesBetween(freshKitchen, before, after);
      if (!lines) return;
      expect(lines.map((line) => line.valueTenths)).toEqual([380, 390]);
      expect(lines[0].seq).toBeLessThan(lines[1].seq);
      if (target.clock) expect(lines[1].occurredAt).toBe(lines[0].occurredAt);
    });
  });
});

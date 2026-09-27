import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { resolveTarget, type Target } from '../test-support/target';

// 23:30 CDT on 2026-10-20, when the UTC date is already the 21st: a business day read from the
// UTC date instead of the kitchen's wall clock lands on the wrong day.
const CALL_AT = Date.UTC(2026, 9, 21, 4, 30);
const CALL_BUSINESS_DAY = '2026-10-20';

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

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

async function connect(target: Target, path: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(path, target.baseUrl),
    target.fetch ? { fetch: target.fetch } : undefined,
  );
  const client = new Client({ name: 'conformance', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

function walkInCall(requestId: string) {
  return {
    name: 'log_reading',
    arguments: {
      check_point: 'walk_in',
      value: 38,
      measured: 'air',
      words: 'the walk-in reads 38',
      initials: 'AB',
      screen_id: 'conformance-wall',
      request_id: requestId,
    },
  };
}

describe(`MCP conformance on the ${inject('target')} target`, () => {
  let target: Target;
  let kitchenId: string;

  beforeAll(async () => {
    target = await resolveTarget(inject('target'), deployedBaseUrl());
    target.clock?.set(CALL_AT);
    kitchenId = await target.createKitchen();
  });

  afterAll(async () => {
    await target?.dispose();
  });

  it('lists exactly the log_reading tool for a client declaring no capabilities', async () => {
    const client = await connect(target, `/mcp/k/${kitchenId}`);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(['log_reading']);
    } finally {
      await client.close();
    }
  });

  it('logs walk-in 38 for AB, reads it back in range, and stores every field of the line', async () => {
    const client = await connect(target, `/mcp/k/${kitchenId}`);
    const before = target.clock?.now() ?? Date.now();
    let result: ToolResult;
    try {
      result = (await client.callTool(walkInCall(crypto.randomUUID()))) as ToolResult;
    } finally {
      await client.close();
    }
    const after = target.clock?.now() ?? Date.now();

    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toEqual({ type: 'text', text: 'Walk-in, 38, in range, AB' });
    expect(result.structuredContent).toMatchObject({ contractVersion: 1, outcome: 'in_range' });

    if (!target.readLines) return;
    const days = [...new Set([chicagoBusinessDay(before), chicagoBusinessDay(after)])];
    const lines = (await Promise.all(days.map((day) => target.readLines?.(kitchenId, day) ?? []))).flat();
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
});

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lineTimeLabel } from '../domain/business-day';
import type { StoredLine } from '../store/port';
import { resolveTarget, type Target } from '../test-support/target';

const ZONE = 'America/Chicago';
// 2026-11-01 01:30 happens twice in Chicago: first in CDT, then again an hour later in CST. Both
// belong to the business day that started at 04:00 on 2026-10-31.
const FIRST_130 = Date.parse('2026-11-01T06:30:00Z');
const SECOND_130 = Date.parse('2026-11-01T07:30:00Z');
const REPEATED_HOUR_DAY = '2026-10-31';
const AFTERNOON = Date.parse('2026-10-20T19:00:00Z');
const AFTERNOON_DAY = '2026-10-20';

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: {
    outcome?: string;
    lineId?: string;
    verdict?: string;
    rule?: { id: string };
  };
}

interface Reading {
  check_point: string;
  value: number;
  initials: string;
  measured?: string;
}

describe('readings routed to their own rule row, through MCP', () => {
  let target: Target;

  beforeAll(async () => {
    target = await resolveTarget('in-process');
  });

  afterAll(async () => {
    await target?.dispose();
  });

  async function kitchenAt(instant: number): Promise<string> {
    target.clock?.set(instant);
    return target.createKitchen();
  }

  async function logAt(kitchenId: string, instant: number, reading: Reading): Promise<ToolResult> {
    target.clock?.set(instant);
    const transport = new StreamableHTTPClientTransport(
      new URL(`/mcp/k/${kitchenId}`, target.baseUrl),
      target.fetch ? { fetch: target.fetch } : undefined,
    );
    const client = new Client({ name: 'judging', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    try {
      const args = { ...reading, screen_id: 'judging-wall', request_id: crypto.randomUUID() };
      return (await client.callTool({ name: 'log_reading', arguments: args })) as ToolResult;
    } finally {
      await client.close();
    }
  }

  async function storedLine(kitchenId: string, day: string, result: ToolResult): Promise<StoredLine> {
    const lines = (await target.readLines?.(kitchenId, day)) ?? [];
    const line = lines.find((candidate) => candidate.id === result.structuredContent?.lineId);
    if (!line) throw new Error(`no stored line ${result.structuredContent?.lineId} on ${day}`);
    return line;
  }

  it('judges soup well 134.9 at 1:30 AM CST out of range by hot holding, on business day 2026-10-31', async () => {
    const kitchenId = await kitchenAt(SECOND_130);
    const result = await logAt(kitchenId, SECOND_130, {
      check_point: 'soup_well',
      value: 134.9,
      measured: 'chicken_soup',
      initials: 'MR',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toEqual({ type: 'text', text: 'Soup well, 134.9, out of range, MR' });
    expect(result.structuredContent).toMatchObject({ outcome: 'out_of_range', rule: { id: 'hot_holding' } });
    const line = await storedLine(kitchenId, REPEATED_HOUR_DAY, result);
    expect(line).toMatchObject({ businessDay: REPEATED_HOUR_DAY, outcome: 'out_of_range', ruleId: 'hot_holding' });
  });

  it('stores 1:30 AM CDT and 1:30 AM CST in sequence on 2026-10-31 and labels each with its zone', async () => {
    const kitchenId = await kitchenAt(FIRST_130);
    const first = await logAt(kitchenId, FIRST_130, { check_point: 'soup_well', value: 150, initials: 'AB' });
    const second = await logAt(kitchenId, SECOND_130, { check_point: 'soup_well', value: 151, initials: 'AB' });

    const lines = (await target.readLines?.(kitchenId, REPEATED_HOUR_DAY)) ?? [];
    expect(lines.map((line) => line.id)).toEqual([first.structuredContent?.lineId, second.structuredContent?.lineId]);
    expect(lines[0].seq).toBeLessThan(lines[1].seq);
    expect(lines.map((line) => line.occurredAt)).toEqual([FIRST_130, SECOND_130]);
    expect(lines.map((line) => line.businessDay)).toEqual([REPEATED_HOUR_DAY, REPEATED_HOUR_DAY]);
    expect(lines.map((line) => lineTimeLabel(line.occurredAt, ZONE))).toEqual(['1:30 AM CDT', '1:30 AM CST']);
  });

  it('judges soup well 135.0 in range by hot holding', async () => {
    const kitchenId = await kitchenAt(AFTERNOON);
    const result = await logAt(kitchenId, AFTERNOON, {
      check_point: 'soup_well',
      value: 135.0,
      measured: 'chicken_soup',
      initials: 'JT',
    });

    expect(result.content[0]?.text).toBe('Soup well, 135, in range, JT');
    expect(result.structuredContent).toMatchObject({ outcome: 'in_range', rule: { id: 'hot_holding' } });
  });

  it('judges prime rib at 130 in range by the roast row, and chicken soup at 130 out of range', async () => {
    const kitchenId = await kitchenAt(AFTERNOON);
    const roast = await logAt(kitchenId, AFTERNOON, {
      check_point: 'carving_station',
      value: 130,
      measured: 'prime_rib',
      initials: 'KL',
    });
    const soup = await logAt(kitchenId, AFTERNOON, {
      check_point: 'soup_well',
      value: 130,
      measured: 'chicken_soup',
      initials: 'KL',
    });

    expect(roast.structuredContent).toMatchObject({ outcome: 'in_range', rule: { id: 'hot_holding_roast' } });
    expect(soup.structuredContent).toMatchObject({ outcome: 'out_of_range', rule: { id: 'hot_holding' } });
  });

  it('stores a cooling reading as not covered yet, with its value and no verdict or rule', async () => {
    const kitchenId = await kitchenAt(AFTERNOON);
    const result = await logAt(kitchenId, AFTERNOON, { check_point: 'cooling', value: 70, initials: 'AB' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toEqual({ type: 'text', text: 'Cooling, 70, not covered yet, AB' });
    expect(result.structuredContent?.outcome).toBe('not_covered');
    expect(result.structuredContent?.rule).toBeUndefined();
    const line = await storedLine(kitchenId, AFTERNOON_DAY, result);
    expect(line).toMatchObject({ outcome: 'not_covered', valueTenths: 700, verdict: null, ruleId: null, ruleSnapshot: null });
  });

  describe('receiving, where each delivered food names its own rule', () => {
    it.each([
      ['a milk delivery at 44 by the milk law', 'milk', 44, 'in_range', 'receiving_law_milk'],
      ['a cold delivery at 44 by 3-202.11(A)', 'raw_chicken', 44, 'out_of_range', 'receiving_cold'],
      ['a hot delivery at 135.0 by 3-202.11(D)', 'catered_chili', 135.0, 'in_range', 'receiving_hot'],
    ])('judges %s', async (_label, measured, value, outcome, ruleId) => {
      const kitchenId = await kitchenAt(AFTERNOON);
      const result = await logAt(kitchenId, AFTERNOON, { check_point: 'receiving', value, measured, initials: 'MR' });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ outcome, rule: { id: ruleId } });
    });
  });

  describe('a reading with no row for what was measured', () => {
    it.each([
      ['a receiving reading that names no food', { check_point: 'receiving', value: 40, initials: 'JT' }, 'Receiving, 40'],
      [
        'a freezer reading measured as chicken soup',
        { check_point: 'freezer', value: 2, measured: 'chicken_soup', initials: 'JT' },
        'Freezer, 2',
      ],
    ])('stores %s as not covered yet, never judged by another row', async (_label, reading, spoken) => {
      const kitchenId = await kitchenAt(AFTERNOON);
      const result = await logAt(kitchenId, AFTERNOON, reading);

      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toBe(`${spoken}, not covered yet, JT`);
      expect(result.structuredContent?.outcome).toBe('not_covered');
      const line = await storedLine(kitchenId, AFTERNOON_DAY, result);
      expect(line).toMatchObject({ outcome: 'not_covered', valueTenths: reading.value * 10, ruleId: null });
    });
  });

  it('judges the freezer air at 5 below in range by the house freezer limit', async () => {
    const kitchenId = await kitchenAt(AFTERNOON);
    const result = await logAt(kitchenId, AFTERNOON, { check_point: 'freezer', value: -5, initials: 'KL' });

    expect(result.content[0]?.text).toBe('Freezer, -5, in range, KL');
    expect(result.structuredContent).toMatchObject({ outcome: 'in_range', rule: { id: 'freezer_limit' } });
  });
});

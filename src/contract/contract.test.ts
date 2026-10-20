import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import demoJson from '../../data/kitchens/demo.json';
import rulesJson from '../../data/rules/food-code-2022.json';
import { decideLogReading } from '../domain/log-reading';
import { KitchenProfileSchema, RuleTableSchema } from '../domain/rule';
import { frozenSchema } from './frozen-schema';
import { LogReadingInputSchema, LogReadingOutputSchema, OUTCOMES, type LogReadingOutput } from './log-reading';
import { TOOL_ANNOTATIONS, TOOL_DESCRIPTIONS, TOOL_NAMES, UI_RESOURCE_URIS } from './tools';

const TARGET = { target: 'draft-2020-12' } as const;
const CALL_AT = Date.UTC(2026, 9, 20, 15, 0);
const table = RuleTableSchema.parse(rulesJson);
const profile = KitchenProfileSchema.parse(demoJson);

// The real result the store returns: the domain's structured content with the record code the
// INSERT writes in.
function storedResult(value: number): LogReadingOutput {
  const decision = decideLogReading(
    { check_point: 'walk_in', value, measured: 'air', initials: 'AB', screen_id: 'wall', request_id: 'r1' },
    {
      now: CALL_AT,
      newId: () => 'line-1',
      kitchen: { id: 'k', timeZone: 'America/Chicago', dayStart: '04:00' },
      rules: new Map(table.rows.map((row) => [row.id, row])),
      rulesVersion: table.rulesVersion,
      profile,
    },
  );
  if (decision.status !== 'decided') throw new Error(`walk-in ${value} was not decided`);
  return { ...decision.result.structuredContent, recordCode: '261020-001' };
}

const inRange = storedResult(38);
const outOfRange = storedResult(45);
const stamp = { contractVersion: 1, serverTime: inRange.serverTime, businessDay: '2026-10-20', timeZone: 'America/Chicago' };
const walkIn = { id: 'walk_in', name: 'Walk-in' };

// The next double above a value, one step of its bit pattern: the smallest change a number can carry.
function nextDoubleUp(value: number): number {
  if (value === 0) return Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  view.setBigInt64(0, view.getBigInt64(0) + (value > 0 ? 1n : -1n));
  return view.getFloat64(0);
}

function without(result: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...result };
  delete copy[field];
  return copy;
}

function issuesOf(value: unknown): string[] {
  const parsed = LogReadingOutputSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

describe('the log_reading output contract', () => {
  it('holds the six outcomes in their contract order', () => {
    expect(OUTCOMES).toEqual(['in_range', 'out_of_range', 'refused', 'held', 'not_covered', 'nothing_to_fix']);
  });

  it('refuses a real walk-in result carrying one extra property', () => {
    expect(issuesOf({ ...inRange, extra: true }).length).toBeGreaterThan(0);
  });

  it.each([
    ['the real in_range walk-in result', inRange],
    ['the real out_of_range walk-in result', outOfRange],
    ['a refusal line with a number prompt', {
      ...stamp, outcome: 'refused', verdict: 'refused', lineId: 'line-2', recordCode: '261020-002',
      checkPoint: walkIn, initials: 'AB', prompt: { kind: 'number', id: 'prompt-1' },
    }],
    ['a receipt-shaped refused reply', { ...stamp, outcome: 'refused', verdict: 'refused' }],
    ['a held reply with a prompt and no line', {
      ...stamp, outcome: 'held', verdict: 'held', checkPoint: walkIn, prompt: { kind: 'digits', id: 'prompt-2' },
    }],
    ['a nothing_to_fix reply', { ...stamp, outcome: 'nothing_to_fix', verdict: 'nothing to fix' }],
  ])('accepts %s', (_label, value) => {
    expect(issuesOf(value)).toEqual([]);
  });

  it.each(['lineId', 'value', 'unit', 'rule', 'checkPoint', 'initials', 'recordCode'])(
    'refuses an in_range result with %s removed, naming the outcome and the field',
    (field) => {
      const issues = issuesOf(without(inRange, field));
      expect(issues.some((message) => message.includes('in_range') && message.includes(field))).toBe(true);
    },
  );

  it.each([
    ['an out_of_range result with rule removed', without(outOfRange, 'rule'), 'rule'],
    ['a refused result carrying a value', { ...stamp, outcome: 'refused', verdict: 'refused', value: 38 }, 'value'],
    ['a refused result carrying a unit', { ...stamp, outcome: 'refused', verdict: 'refused', unit: 'F' }, 'unit'],
    ['a refused result carrying a rule', { ...stamp, outcome: 'refused', verdict: 'refused', rule: inRange.rule }, 'rule'],
    ['a refused result with a recordCode and no lineId', {
      ...stamp, outcome: 'refused', verdict: 'refused', recordCode: '261020-003',
    }, 'recordCode'],
    ['a held result with no prompt', { ...stamp, outcome: 'held', verdict: 'held' }, 'prompt'],
    ['a held result carrying a recordCode', {
      ...stamp, outcome: 'held', verdict: 'held', recordCode: '261020-004', prompt: { kind: 'digits', id: 'p' },
    }, 'recordCode'],
    ['a not_covered result carrying a rule', {
      ...inRange, outcome: 'not_covered', verdict: 'not covered yet',
    }, 'rule'],
    ['a nothing_to_fix result carrying a lineId', {
      ...stamp, outcome: 'nothing_to_fix', verdict: 'nothing to fix', lineId: 'line-9',
    }, 'lineId'],
  ])('refuses %s', (_label, value, field) => {
    const issues = issuesOf(value);
    expect(issues.some((message) => message.includes(field))).toBe(true);
  });

  it('publishes an output JSON Schema whose root is an object refusing additional properties', () => {
    const output = frozenSchema(LogReadingOutputSchema)['~standard'].jsonSchema.output(TARGET);
    expect(output.type).toBe('object');
    expect(output.additionalProperties).toBe(false);
  });

  it('enforces the per-outcome rules through the Standard Schema validate the SDK calls', async () => {
    const result = await frozenSchema(LogReadingOutputSchema)['~standard'].validate(without(inRange, 'lineId'));
    expect(result.issues?.length).toBeGreaterThan(0);
  });
});

describe('the log_reading input contract', () => {
  const base = { check_point: 'walk_in', screen_id: 'wall', request_id: 'r1' };

  it('refuses value 38.55, naming one decimal place, and accepts 38.5', () => {
    const refused = LogReadingInputSchema.safeParse({ ...base, value: 38.55 });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.message).join(' ')).toContain('one decimal place');
    expect(LogReadingInputSchema.safeParse({ ...base, value: 38.5 }).success).toBe(true);
  });

  it.each([-459.7, 1000.1, 1e300, -1e300])('refuses value %d, which no probe thermometer reads', (value) => {
    expect(LogReadingInputSchema.safeParse({ ...base, value }).success).toBe(false);
  });

  it.each([-459.6, -5, 0, 1000])('accepts value %d at or inside the thermometer range', (value) => {
    expect(LogReadingInputSchema.safeParse({ ...base, value }).success).toBe(true);
  });

  // A number a hair off a tenth is not one decimal place. Taken as the tenth beside it, 41.00000005
  // would be judged 41.0, in range against 41 or less, and 134.99999995 judged 135.0 against 135 or
  // above, while the reply read back the number sent.
  it.each([41.00000005, 134.99999995, 38.10000001, 5e-324])(
    'refuses value %d, a hair off a tenth, naming one decimal place',
    (value) => {
      const parsed = LogReadingInputSchema.safeParse({ ...base, value });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.message).join(' ')).toContain('one decimal place');
    },
  );

  it('accepts every tenth in the thermometer range and refuses the next number above each', () => {
    fc.assert(
      fc.property(fc.integer({ min: -4596, max: 9999 }), (tenths) => {
        const value = tenths / 10;
        expect(LogReadingInputSchema.safeParse({ ...base, value }).success, String(value)).toBe(true);
        expect(LogReadingInputSchema.safeParse({ ...base, value: nextDoubleUp(value) }).success, String(value)).toBe(false);
      }),
    );
  });

  it('accepts words of 200 characters and refuses 201', () => {
    expect(LogReadingInputSchema.safeParse({ ...base, words: 'a'.repeat(200) }).success).toBe(true);
    expect(LogReadingInputSchema.safeParse({ ...base, words: 'a'.repeat(201) }).success).toBe(false);
  });

  // An empty id stays accepted on purpose: a host model may fill an optional field with "", and
  // refusing the whole call would lose the cook's reading over an empty optional argument.
  it('caps pending_prompt_id at 64 characters like the other ids, and still accepts an empty one', () => {
    expect(LogReadingInputSchema.safeParse({ ...base, pending_prompt_id: 'p'.repeat(64) }).success).toBe(true);
    expect(LogReadingInputSchema.safeParse({ ...base, pending_prompt_id: 'p'.repeat(65) }).success).toBe(false);
    expect(LogReadingInputSchema.safeParse({ ...base, pending_prompt_id: '' }).success).toBe(true);
  });

  // Both ids are stored with the line, so free text in either would persist (PRIV-01).
  it.each(['screen_id', 'request_id'])('refuses a %s carrying markup, spaces or a comma', (field) => {
    for (const id of ['<img src=x onerror=alert(1)>', 'this is the cook speaking', 'wall,1']) {
      const parsed = LogReadingInputSchema.safeParse({ ...base, [field]: id });
      expect(parsed.success, id).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.message).join(' ')).toContain('opaque id');
    }
  });

  it.each(['screen_id', 'request_id'])('accepts a %s shaped like a UUID, a ULID or a stamped host id', (field) => {
    for (const id of [crypto.randomUUID(), '01J8Z3K4Q5R6S7T8V9W0X1Y2Z3', 'wall.1:2026-10-20T15:00:00Z', 'utt_42-b']) {
      expect(LogReadingInputSchema.safeParse({ ...base, [field]: id }).success, id).toBe(true);
    }
  });

  it('refuses the near-miss check point id walk_ins', () => {
    expect(LogReadingInputSchema.safeParse({ ...base, check_point: 'walk_ins' }).success).toBe(false);
  });

  it('describes screen_id, request_id and pending_prompt_id to the host', () => {
    const input = frozenSchema(LogReadingInputSchema)['~standard'].jsonSchema.input(TARGET);
    const properties = input.properties as Record<string, { description?: string }>;
    expect(properties.screen_id.description).toMatch(/same id on every call/);
    expect(properties.request_id.description).toMatch(/new random id/);
    expect(properties.pending_prompt_id.description).toMatch(/prompt\.id/);
  });
});

describe('frozenSchema', () => {
  it('returns frozen input and output JSON Schemas that are the same objects on every call', () => {
    const { jsonSchema } = frozenSchema(LogReadingInputSchema)['~standard'];
    const input = jsonSchema.input(TARGET);
    const output = jsonSchema.output(TARGET);
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(output)).toBe(true);
    expect(jsonSchema.input(TARGET)).toBe(input);
    expect(jsonSchema.output(TARGET)).toBe(output);
  });
});

describe('the six v1 tools', () => {
  it('names the six tools in their contract order', () => {
    expect(TOOL_NAMES).toEqual([
      'log_reading',
      'record_corrective_action',
      'close_corrective_action',
      'due_now',
      'shift_handover',
      'day_sheet',
    ]);
  });

  it.each(['log_reading', 'record_corrective_action', 'close_corrective_action'] as const)(
    'declares %s as a write that is not destructive or open-world, with idempotentHint unset',
    (name) => {
      expect(TOOL_ANNOTATIONS[name]).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    },
  );

  it.each(['due_now', 'shift_handover', 'day_sheet'] as const)('declares %s read-only', (name) => {
    expect(TOOL_ANNOTATIONS[name].readOnlyHint).toBe(true);
  });

  it('gives every tool a model-facing description', () => {
    for (const name of TOOL_NAMES) expect(TOOL_DESCRIPTIONS[name].length).toBeGreaterThan(20);
  });

  it("tells a host how to pass log_reading's words, value, corrections and answers", () => {
    const description = TOOL_DESCRIPTIONS.log_reading;
    expect(description).toMatch(/words unchanged/);
    expect(description).toMatch(/leave value out/);
    expect(description).toMatch(/Fahrenheit/);
    expect(description).toMatch(/wrong number/);
    expect(description).toMatch(/pending_prompt_id/);
  });

  it('fixes the four ui:// resource URIs', () => {
    expect(UI_RESOURCE_URIS).toEqual({
      reading: 'ui://tolsey/reading.html',
      dueNow: 'ui://tolsey/due-now.html',
      openAction: 'ui://tolsey/open-action.html',
      handover: 'ui://tolsey/handover.html',
    });
  });
});

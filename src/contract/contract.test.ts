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

  it('accepts words of 200 characters and refuses 201', () => {
    expect(LogReadingInputSchema.safeParse({ ...base, words: 'a'.repeat(200) }).success).toBe(true);
    expect(LogReadingInputSchema.safeParse({ ...base, words: 'a'.repeat(201) }).success).toBe(false);
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

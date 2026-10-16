import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ToolCallResult } from '../client/mcp-client';
import { PHRASE_TABLE } from '../test-support/phrase-table';
import { intentFor } from './intent';
import { WALL_PROFILE } from './profile';
import { SPEAKER_LABEL, TAUGHT_PHRASES } from './wall-copy';
import { initialWallState, wallReducer, type WallState } from './wall-state';
import { WallView } from './WallView';

const ACTIONS = { say: () => undefined, edit: () => undefined, retryStart: () => undefined };
const EMPTY_PASS = 'No reading yet. Log one to see it here.';
const RULE_AT_MOST_41 = { id: 'unit_air_cold', comparator: 'at_most', limit: 41, unit: 'F', sourceKind: 'house_rule' } as const;

type Pass = NonNullable<WallState['pass']>;

const READY: WallState = wallReducer(initialWallState(WALL_PROFILE), { type: 'started' });

const IN_RANGE_PASS: Pass = {
  outcome: 'in_range',
  lineId: 'line-1',
  recordCode: '261016-001',
  checkPoint: { id: 'walk_in', name: 'Walk-in' },
  value: 38,
  unit: 'F',
  verdict: 'in range',
  rule: RULE_AT_MOST_41,
  initials: 'AB',
};

function render(state: WallState): string {
  return renderToStaticMarkup(createElement(WallView, { state, actions: ACTIONS }));
}

function withPass(pass: Partial<Pass>): string {
  return render({ ...READY, pass: { ...IN_RANGE_PASS, ...pass } });
}

function result(outcome: string, text: string, fields: Record<string, unknown>): ToolCallResult {
  return { content: [{ type: 'text', text }], structuredContent: { contractVersion: 1, outcome, ...fields } };
}

function afterResult(state: WallState, said: string, answer: ToolCallResult): WallState {
  return [
    { type: 'sent', said } as const,
    { type: 'resultReceived', said, result: answer } as const,
  ].reduce(wallReducer, state);
}

// React writes a double quotation mark in text as an entity, so the markup is decoded before phrases
// are read out of it.
function decoded(markup: string): string {
  return markup
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function textsMatching(markup: string, pattern: RegExp): string[] {
  return [...markup.matchAll(pattern)].map((match) => decoded(match[1]));
}

function buttonsOf(markup: string): string[] {
  return markup.match(/<button\b[^>]*>/g) ?? [];
}

describe('the pass shows a logged line with the fields the result carried', () => {
  it.fails('an in_range line shows the check point, the value in °F, the verdict, the limit, the initials and the record code', () => {
    const markup = withPass({});
    for (const text of ['Walk-in', '38°F', 'in range', 'at most 41°F', 'AB', '261016-001']) expect(markup).toContain(text);
    expect(markup).not.toContain('out-of-range');
  });

  it.fails('an out_of_range line shows its verdict word and carries the out-of-range class beside it', () => {
    const markup = withPass({ outcome: 'out_of_range', value: 45, verdict: 'out of range' });
    expect(markup).toContain('out of range');
    expect(markup).toMatch(/class="[^"]*\bout-of-range\b/);
  });

  it.fails('a not_covered line shows not covered yet and no limit', () => {
    const markup = withPass({ outcome: 'not_covered', checkPoint: { id: 'cooling', name: 'Cooling' }, verdict: 'not covered yet', rule: undefined });
    expect(markup).toContain('not covered yet');
    expect(markup).not.toMatch(/at (most|least)/);
  });

  it.fails('an at_least rule is written as at least its limit', () => {
    const rule = { id: 'hot_holding', comparator: 'at_least', limit: 135, unit: 'F', sourceKind: 'food_code' } as const;
    expect(withPass({ value: 140, rule })).toContain('at least 135°F');
  });

  it.fails('a value with a tenth shows as 38.5', () => {
    expect(withPass({ value: 38.5 })).toContain('38.5°F');
  });

  it.fails('a whole value shows as 38, never 38.0', () => {
    const markup = withPass({ value: 38 });
    expect(markup).toContain('38°F');
    expect(markup).not.toContain('38.0');
  });

  it.fails('before the first line the pass shows its empty-state sentence', () => {
    expect(render(READY)).toContain(EMPTY_PASS);
  });
});

describe('a refusal or a held question changes the exchange only', () => {
  it.fails('a refused result shows its reply under the speaker label and the previous pass unchanged', () => {
    const reply = 'I need the number on the thermometer. What does reach-in two read?';
    const state = afterResult({ ...READY, pass: IN_RANGE_PASS }, 'reach-in two is fine', result('refused', reply, { verdict: 'refused' }));
    const markup = render(state);
    expect(markup).toContain('reach-in two is fine');
    expect(markup).toContain(reply);
    expect(markup).toContain(SPEAKER_LABEL);
    expect(markup).toContain('261016-001');
  });

  it.fails('a held result shows its question and leaves the empty pass empty', () => {
    const reply = 'Say it one digit at a time. What does the walk-in read?';
    const state = afterResult(READY, 'walk-in 15', result('held', reply, { verdict: 'held', value: 15, prompt: { kind: 'digit_repeat', id: 'p-1' } }));
    const markup = render(state);
    expect(markup).toContain(reply);
    expect(markup).toContain(EMPTY_PASS);
  });
});

describe('the controls follow the start', () => {
  it.fails('while starting every chip and the send button are disabled', () => {
    const buttons = buttonsOf(render(initialWallState(WALL_PROFILE)));
    expect(buttons.length).toBeGreaterThanOrEqual(5);
    for (const button of buttons) expect(button).toContain('disabled=""');
  });

  it.fails('once ready no chip and no send button is disabled', () => {
    const buttons = buttonsOf(render(READY));
    expect(buttons.length).toBeGreaterThanOrEqual(5);
    for (const button of buttons) expect(button).not.toContain('disabled');
  });

  it.fails('a failed start shows its sentence, a Retry button and a disabled field', () => {
    const error = 'Could not open the MCP session (status 500).';
    const markup = render(wallReducer(initialWallState(WALL_PROFILE), { type: 'startFailed', error }));
    expect(markup).toContain(error);
    expect(markup).toMatch(/<button\b[^>]*>Retry<\/button>/);
    expect(markup).toMatch(/<input\b[^>]*disabled=""/);
  });
});

describe('every phrase the page teaches parses to its phrase-table entry', () => {
  const markup = render(READY);
  const chips = textsMatching(markup, /<button\b[^>]*class="chip"[^>]*>([^<]*)<\/button>/g);
  // Tags are dropped before double quotation marks are looked for, so attribute values never count.
  const textOnly = markup.replace(/<[^>]*>/g, ' ');
  const quoted = [...textsMatching(markup, /<q>([^<]*)<\/q>/g), ...textsMatching(decoded(textOnly), /"([^"]*)"/g)];
  const extracted = [...new Set([...chips, ...quoted])];

  it.fails('finds the chips and the quoted example in the rendered wall', () => {
    expect(chips.length).toBeGreaterThan(0);
    expect(quoted.length).toBeGreaterThan(0);
  });

  it.fails.each(extracted.length > 0 ? extracted : ['(nothing extracted)'])('%s has a row read with no question open and gives that row', (phrase) => {
    const row = PHRASE_TABLE.find((entry) => entry.phrase === phrase && entry.openPrompt === null);
    expect(row).toBeDefined();
    expect(intentFor(phrase, WALL_PROFILE, null)).toStrictEqual(row?.expected);
  });

  it.fails('the phrases extracted are exactly the taught phrases', () => {
    expect([...extracted].sort()).toEqual([...TAUGHT_PHRASES].sort());
  });
});

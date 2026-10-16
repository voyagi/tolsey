import { describe, expect, it } from 'vitest';
import type { ToolCallResult } from '../client/mcp-client';
import type { Outcome } from '../contract/log-reading';
import { WALL_PROFILE } from './profile';
import { controlsEnabled, initialWallState, wallReducer, type WallEvent, type WallState } from './wall-state';

const SAID = 'the walk-in reads 38';
const RULE_AT_MOST_41 = { id: 'unit_air_cold', comparator: 'at_most', limit: 41, unit: 'F', sourceKind: 'house_rule' } as const;

const VERDICTS: Record<Outcome, string> = {
  in_range: 'in range',
  out_of_range: 'out of range',
  not_covered: 'not covered yet',
  refused: 'refused',
  held: 'held',
  nothing_to_fix: 'nothing to fix',
};

const REPLIES: Record<Outcome, string> = {
  in_range: 'Walk-in, 38, in range, AB',
  out_of_range: 'Walk-in, 45, out of range, AB',
  not_covered: 'Cooling, 70, logged, not covered yet, AB',
  refused: 'I need the number on the thermometer. What does reach-in two read?',
  held: 'Say it one digit at a time. What does the walk-in read?',
  nothing_to_fix: 'There is nothing to fix.',
};

const COMMON = { contractVersion: 1, serverTime: '2026-10-16T15:00:00.000Z', businessDay: '2026-10-16', timeZone: 'America/Chicago' };

const LINE = {
  lineId: 'line-1',
  recordCode: '261016-001',
  checkPoint: { id: 'walk_in', name: 'Walk-in' },
  value: 38,
  unit: 'F',
  initials: 'AB',
};

// Each outcome carries exactly the fields docs/API.md lists for it.
const STRUCTURED: Record<Outcome, Record<string, unknown>> = {
  in_range: { ...LINE, rule: RULE_AT_MOST_41 },
  out_of_range: { ...LINE, lineId: 'line-2', recordCode: '261016-002', value: 45, rule: RULE_AT_MOST_41 },
  not_covered: { ...LINE, lineId: 'line-3', recordCode: '261016-003', checkPoint: { id: 'cooling', name: 'Cooling' }, value: 70 },
  refused: { lineId: 'line-4', recordCode: '261016-004', checkPoint: { id: 'reach_in_2', name: 'Reach-in two' }, initials: 'AB', prompt: { kind: 'number', id: 'prompt-1' } },
  held: { checkPoint: { id: 'walk_in', name: 'Walk-in' }, value: 15, unit: 'F', initials: 'AB', prompt: { kind: 'digit_repeat', id: 'prompt-2' } },
  nothing_to_fix: {},
};

function resultOf(outcome: Outcome, overrides: Record<string, unknown> = {}): ToolCallResult {
  return {
    content: [{ type: 'text', text: REPLIES[outcome] }],
    structuredContent: { ...COMMON, outcome, verdict: VERDICTS[outcome], ...STRUCTURED[outcome], ...overrides },
  };
}

function reduce(state: WallState, ...events: WallEvent[]): WallState {
  return events.reduce(wallReducer, state);
}

const READY = reduce(initialWallState(WALL_PROFILE), { type: 'started' });

function received(state: WallState, result: ToolCallResult, said = SAID): WallState {
  return reduce(state, { type: 'sent', said }, { type: 'resultReceived', said, result });
}

const WITH_PASS = received(READY, resultOf('in_range'));

describe('a result of each outcome', () => {
  it.each<[Outcome]>([['in_range'], ['out_of_range'], ['not_covered']])(
    'a %s result sets the exchange to the words and the reply and replaces the pass with its own fields',
    (outcome) => {
      const result = resultOf(outcome);
      const state = received(WITH_PASS, result, 'the words sent');
      const { lineId, recordCode, checkPoint, value, unit, verdict, rule, initials } = result.structuredContent ?? {};
      expect(state.exchange).toEqual({ said: 'the words sent', reply: REPLIES[outcome], source: 'server' });
      expect(state.pass).toStrictEqual({ outcome, lineId, recordCode, checkPoint, value, unit, verdict, rule, initials });
    },
  );

  it.each<[Outcome]>([['refused'], ['held'], ['nothing_to_fix']])(
    'a %s result sets the exchange and leaves the pass as it was',
    (outcome) => {
      const state = received(WITH_PASS, resultOf(outcome), 'reach-in two is fine');
      expect(state.exchange).toEqual({ said: 'reach-in two is fine', reply: REPLIES[outcome], source: 'server' });
      expect(state.pass).toBe(WITH_PASS.pass);
    },
  );

  it('a not_covered pass carries no rule', () => {
    expect(received(READY, resultOf('not_covered')).pass?.rule).toBeUndefined();
  });

  it('an out_of_range pass keeps the server verdict word', () => {
    expect(received(READY, resultOf('out_of_range')).pass?.verdict).toBe('out of range');
  });

  it('a correcting line carrying supersedesLineId replaces the pass as the newest reading', () => {
    const correction = resultOf('in_range', { lineId: 'line-9', recordCode: '261016-009', value: 37, supersedesLineId: 'line-1' });
    const state = received(WITH_PASS, correction);
    expect(state.pass).toMatchObject({ lineId: 'line-9', recordCode: '261016-009', value: 37 });
  });
});

describe('a value at the rule limit shows the verdict the result carried', () => {
  it.each(['in range', 'out of range'])('a result at 41 with limit 41 carrying %s shows %s on the pass', (verdict) => {
    const outcome = verdict === 'in range' ? 'in_range' : 'out_of_range';
    const state = received(READY, resultOf(outcome, { value: RULE_AT_MOST_41.limit, verdict }));
    expect(state.pass).toMatchObject({ value: 41, verdict, rule: { limit: 41 } });
  });
});

describe('one call in flight at a time', () => {
  it('a sent event while a call is in flight leaves the state unchanged', () => {
    const inFlight = reduce(READY, { type: 'sent', said: SAID });
    expect(inFlight.inFlight).toBe(true);
    expect(wallReducer(inFlight, { type: 'sent', said: 'walk-in 15' })).toBe(inFlight);
  });

  it('a resultReceived clears inFlight', () => {
    expect(received(READY, resultOf('in_range')).inFlight).toBe(false);
  });
});

describe('the open question', () => {
  it('is set from the result prompt and cleared by a result without one', () => {
    const asked = received(READY, resultOf('held'));
    expect(asked.openPrompt).toEqual({ kind: 'digit_repeat', id: 'prompt-2' });
    expect(received(asked, resultOf('in_range')).openPrompt).toBeNull();
  });

  it('a local reply changes neither the open question nor the pass', () => {
    const asked = received(WITH_PASS, resultOf('held'));
    const state = reduce(asked, { type: 'localReplied', said: 'hello', reply: 'Say a check and its number.' });
    expect(state.openPrompt).toBe(asked.openPrompt);
    expect(state.pass).toBe(asked.pass);
    expect(state.exchange).toEqual({ said: 'hello', reply: 'Say a check and its number.', source: 'wall' });
  });
});

describe('the words in the field', () => {
  it('an edited event sets the draft', () => {
    expect(reduce(READY, { type: 'edited', text: 'walk-in 1' }).draft).toBe('walk-in 1');
  });

  it('a result clears the draft', () => {
    const typed = reduce(READY, { type: 'edited', text: SAID });
    expect(received(typed, resultOf('in_range')).draft).toBe('');
  });

  it('a local reply clears the draft', () => {
    const typed = reduce(READY, { type: 'edited', text: 'hello' });
    expect(reduce(typed, { type: 'localReplied', said: 'hello', reply: 'Say a check.' }).draft).toBe('');
  });

  it('a call that never answered keeps the draft', () => {
    const typed = reduce(READY, { type: 'edited', text: SAID }, { type: 'sent', said: SAID });
    expect(reduce(typed, { type: 'wallReplied', said: SAID, reply: 'the request never reached the server' }).draft).toBe(SAID);
  });
});

describe('controlsEnabled', () => {
  it('is false while starting', () => {
    expect(controlsEnabled(initialWallState(WALL_PROFILE))).toBe(false);
  });

  it('is true once ready with nothing in flight', () => {
    expect(controlsEnabled(READY)).toBe(true);
  });

  it('is false while a call is in flight', () => {
    expect(controlsEnabled(reduce(READY, { type: 'sent', said: SAID }))).toBe(false);
  });

  it('is false after a failed start', () => {
    expect(controlsEnabled(reduce(initialWallState(WALL_PROFILE), { type: 'startFailed', error: 'Could not create a kitchen.' }))).toBe(false);
  });
});

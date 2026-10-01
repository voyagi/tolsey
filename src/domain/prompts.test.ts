import { describe, expect, it } from 'vitest';
import demoJson from '../../data/kitchens/demo.json';
import rulesJson from '../../data/rules/food-code-2022.json';
import type { LogReadingInput } from '../contract/log-reading';
import type { PendingPrompt } from '../store/port';
import { decideLogReading, type DecisionContext } from './log-reading';
import { resolvePrompt } from './prompts';
import { KitchenProfileSchema, RuleTableSchema } from './rule';

const table = RuleTableSchema.parse(rulesJson);
const profile = KitchenProfileSchema.parse(demoJson);

const ASKED_AT = Date.UTC(2026, 9, 20, 19, 0);
const EXPIRES_AT = ASKED_AT + profile.promptExpirySeconds * 1000;

function prompt(overrides: Partial<PendingPrompt> = {}): PendingPrompt {
  return {
    id: 'prompt-1',
    promptKind: 'who_is_logging',
    checkPointId: 'walk_in',
    measured: 'air',
    valueTenths: 380,
    initials: null,
    screenId: 'wall',
    expiresAt: EXPIRES_AT,
    refId: null,
    answered: false,
    repeats: 0,
    supersedes: null,
    ...overrides,
  };
}

function answer(overrides: Partial<LogReadingInput> = {}): LogReadingInput {
  return { screen_id: 'wall', request_id: 'request-2', pending_prompt_id: 'prompt-1', ...overrides };
}

let ids = 0;
function ctxWith(pending: PendingPrompt | null, now = ASKED_AT + 1000): DecisionContext {
  return {
    now,
    newId: () => `id-${++ids}`,
    kitchen: { id: 'kitchen-1', timeZone: 'America/Chicago', dayStart: '04:00' },
    rules: new Map(table.rows.map((row) => [row.id, row])),
    rulesVersion: table.rulesVersion,
    profile,
    prompt: pending,
  };
}

function decide(input: LogReadingInput, pending: PendingPrompt | null, now?: number) {
  const decision = decideLogReading(input, ctxWith(pending, now));
  if (decision.status !== 'decided') throw new Error(`expected a decided call, got ${decision.code}`);
  return decision;
}

describe('resolvePrompt', () => {
  it('treats no prompt as a fresh call', () => {
    expect(resolvePrompt(null, answer({ initials: 'MR' }), ASKED_AT)).toEqual({ kind: 'fresh' });
  });

  it('treats a prompt of a kind this code cannot answer as a fresh call', () => {
    expect(resolvePrompt(prompt({ promptKind: 'wrong_number' }), answer({ initials: 'MR' }), ASKED_AT).kind).toBe('fresh');
    expect(resolvePrompt(prompt({ promptKind: 'toString' }), answer({ initials: 'MR' }), ASKED_AT).kind).toBe('fresh');
  });

  it('treats an answer from another screen as a fresh call', () => {
    expect(resolvePrompt(prompt(), answer({ initials: 'MR', screen_id: 'other' }), ASKED_AT).kind).toBe('fresh');
  });

  it('takes the expiry from the prompt: answered one tick before it, fresh at it', () => {
    expect(resolvePrompt(prompt(), answer({ initials: 'MR' }), EXPIRES_AT - 1).kind).toBe('answer');
    expect(resolvePrompt(prompt(), answer({ initials: 'MR' }), EXPIRES_AT).kind).toBe('fresh');
    expect(resolvePrompt(prompt({ expiresAt: ASKED_AT + 5 }), answer({ initials: 'MR' }), ASKED_AT + 5).kind).toBe(
      'fresh',
    );
  });

  it('treats a new number said with the initials as a fresh call, never dropping it for the held one', () => {
    expect(resolvePrompt(prompt(), answer({ initials: 'MR', value: 40 }), ASKED_AT).kind).toBe('fresh');
    expect(resolvePrompt(prompt(), answer({ initials: 'MR', value: 38 }), ASKED_AT).kind).toBe('answer');
  });

  it('treats another check point named in answer to a number prompt as a fresh call', () => {
    const number = prompt({ promptKind: 'number', checkPointId: 'reach_in_1', valueTenths: null, measured: null });
    expect(resolvePrompt(number, answer({ value: 38, check_point: 'walk_in' }), ASKED_AT).kind).toBe('fresh');
    expect(resolvePrompt(number, answer({ value: 38, check_point: 'reach_in_1' }), ASKED_AT).kind).toBe('answer');
  });

  it('gives an answered prompt the already-answered result, but only after the fresh-call checks', () => {
    expect(resolvePrompt(prompt({ answered: true }), answer({ initials: 'MR' }), ASKED_AT).kind).toBe('already_answered');
    expect(resolvePrompt(prompt({ answered: true }), answer({ initials: 'MR', value: 40 }), ASKED_AT).kind).toBe('fresh');
  });

  it('fills a who_is_logging answer with the held check point, number and measure', () => {
    const resolved = resolvePrompt(prompt(), answer({ initials: 'MR' }), ASKED_AT);
    expect(resolved).toMatchObject({
      kind: 'answer',
      fill: { checkPoint: 'walk_in', value: 38, measured: 'air', initials: 'MR' },
    });
  });
});

describe('decideLogReading with a pending prompt', () => {
  it('logs the held reading for the initials that answer "Who is logging?", linked to the prompt', () => {
    const { event, result } = decide(answer({ initials: 'mr' }), prompt());
    expect(result.structuredContent).toMatchObject({ outcome: 'in_range', value: 38, initials: 'MR' });
    expect(event).toMatchObject({ kind: 'reading', answersId: 'prompt-1', valueTenths: 380, checkPointId: 'walk_in' });
  });

  it('never confirms a held number with a yes on its own', () => {
    const repeat = prompt({ promptKind: 'digit_repeat', valueTenths: 150, initials: 'AB' });
    const { event, result } = decide(answer({ words: 'yes' }), repeat);
    expect(result.structuredContent.outcome).not.toMatch(/in_range|out_of_range/);
    expect(event.kind).not.toBe('reading');
  });

  it('confirms a digit repeat only with a number equal to the one the prompt holds', () => {
    const repeat = prompt({ promptKind: 'digit_repeat', valueTenths: 150, initials: 'AB' });
    expect(decide(answer({ value: 15 }), repeat).event).toMatchObject({ kind: 'reading', valueTenths: 150 });
    expect(decide(answer({ value: 50 }), repeat).event).toMatchObject({ kind: 'held', valueTenths: 500 });
  });

  // A hedge in answer to "Say it one digit at a time" is no repeat: the call is refused, and that
  // refusal answers the hold and asks for the number again.
  it('refuses a digit repeat answered with a hedge, answering the hold with a refusal that asks again', () => {
    const repeat = prompt({ promptKind: 'digit_repeat', valueTenths: 150, initials: 'AB' });
    const { event, result } = decide(answer({ value: 15, words: 'about 15' }), repeat);
    expect(result.structuredContent).toMatchObject({ outcome: 'refused', prompt: { kind: 'number' } });
    expect(event).toMatchObject({ kind: 'refusal', answersId: 'prompt-1', checkPointId: 'walk_in', valueTenths: null });
  });

  // The repeat is compared once its words are read, so "5 below" beside the value 5 is the held -5.
  it('confirms a held -5 when the repeat says "5 below" beside the value 5', () => {
    const repeat = prompt({ promptKind: 'digit_repeat', valueTenths: -50, initials: 'AB' });
    const { event, result } = decide(answer({ value: 5, words: '5 below' }), repeat);
    expect(result.structuredContent).toMatchObject({ outcome: 'in_range', value: -5 });
    expect(event).toMatchObject({ kind: 'reading', valueTenths: -50, answersId: 'prompt-1' });
  });

  it('holds a third different number in a row as "Log it by hand", a receipt that closes the prompt', () => {
    const third = prompt({ id: 'hold-3', promptKind: 'digit_repeat', valueTenths: 160, initials: 'AB', refId: 'hold-1', repeats: 2 });
    const { event, result } = decide(answer({ value: 17, pending_prompt_id: 'hold-3' }), third);
    expect(result.content[0].text).toBe('Log it by hand.');
    expect(result.structuredContent).toMatchObject({ outcome: 'refused' });
    expect(result.structuredContent).not.toHaveProperty('prompt');
    expect(result.structuredContent).not.toHaveProperty('lineId');
    expect(event).toMatchObject({ kind: 'receipt', answersId: 'hold-3', refId: 'hold-1', valueTenths: null });
  });

  it('holds a second different number as a new digit repeat on the same chain', () => {
    const second = prompt({ id: 'hold-2', promptKind: 'digit_repeat', valueTenths: 510, initials: 'AB', refId: 'hold-1', repeats: 1 });
    const { event, result } = decide(answer({ value: 16, pending_prompt_id: 'hold-2' }), second);
    expect(result.structuredContent).toMatchObject({ outcome: 'held', prompt: { kind: 'digit_repeat' } });
    expect(event).toMatchObject({ kind: 'held', answersId: 'hold-2', refId: 'hold-1', valueTenths: 160 });
  });

  it('refuses an answer to a question that holds no number, never logging it as zero', () => {
    const empty = prompt({ valueTenths: null });
    const resolved = resolvePrompt(empty, answer({ initials: 'MR' }), ASKED_AT);
    expect(resolved.kind === 'answer' && resolved.fill.value).toBeUndefined();
    expect(decide(answer({ initials: 'MR' }), empty).result.structuredContent.outcome).toBe('refused');
  });

  it('asks which check again, still holding the number, when an answer to which check names none', () => {
    const whichCheck = prompt({ promptKind: 'which_check', checkPointId: null, measured: null, initials: 'AB' });
    const resolved = resolvePrompt(whichCheck, answer({ initials: 'AB' }), ASKED_AT);
    expect(resolved.kind === 'answer' && resolved.fill.checkPoint).toBeUndefined();
    expect(decide(answer({ initials: 'AB' }), whichCheck).event).toMatchObject({
      kind: 'held',
      promptKind: 'which_check',
      answersId: 'prompt-1',
      checkPointId: null,
      valueTenths: 380,
    });
  });

  // Every decision that stores a number question names its check, so this case reaches the code only
  // from a stored row; the missing check must still reach the fill as unset, never as null.
  it('asks which check for the number answering a number question that names no check', () => {
    const number = prompt({ promptKind: 'number', checkPointId: null, measured: null, valueTenths: null, initials: 'AB' });
    const resolved = resolvePrompt(number, answer({ value: 38 }), ASKED_AT);
    expect(resolved.kind === 'answer' && resolved.fill.checkPoint).toBeUndefined();
    expect(decide(answer({ value: 38 }), number).event).toMatchObject({
      kind: 'held',
      promptKind: 'which_check',
      answersId: 'prompt-1',
      checkPointId: null,
      initials: 'AB',
      valueTenths: 380,
    });
  });

  it('answers an answered prompt with a receipt that answers nothing', () => {
    const { event, result } = decide(answer({ initials: 'MR' }), prompt({ answered: true }));
    expect(result.structuredContent.outcome).toBe('refused');
    expect(event).toMatchObject({ kind: 'receipt', answersId: null, initials: 'MR', checkPointId: 'walk_in' });
  });

  it('stores exactly one event for every decided call', () => {
    const calls: [LogReadingInput, PendingPrompt | null][] = [
      [answer({ pending_prompt_id: undefined, value: 39, initials: 'AB' }), null],
      [answer({ pending_prompt_id: undefined, check_point: 'walk_in', value: 38 }), null],
      [answer({ pending_prompt_id: undefined, check_point: 'walk_in', initials: 'AB' }), null],
      [answer({ initials: 'MR' }), prompt({ answered: true })],
      [answer({ value: 17 }), prompt({ promptKind: 'digit_repeat', valueTenths: 160, refId: 'hold-1', repeats: 2 })],
    ];
    for (const [input, pending] of calls) {
      const { event } = decide(input, pending);
      expect(event.id).toMatch(/^id-/);
    }
  });
});

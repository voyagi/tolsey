import { describe, expect, it } from 'vitest';
import demoJson from '../../data/kitchens/demo.json';
import rulesJson from '../../data/rules/food-code-2022.json';
import type { LogReadingInput } from '../contract/log-reading';
import type { PendingPrompt, ScreenEvent } from '../store/port';
import { decideCorrection } from './correction';
import type { Decided, DecisionContext } from './decision';
import { decideLogReading } from './log-reading';
import { KitchenProfileSchema, RuleTableSchema } from './rule';

const table = RuleTableSchema.parse(rulesJson);
const profile = KitchenProfileSchema.parse(demoJson);

const LOGGED_AT = Date.UTC(2026, 9, 20, 19, 0);
const WINDOW_MS = profile.correctionWindowSeconds * 1000;
const NOTHING_TO_FIX = 'Nothing to fix. Say a check and its number.';

let ids = 0;
function ctxAt(now: number, extra: Partial<DecisionContext> = {}): DecisionContext {
  return {
    now,
    newId: () => `id-${++ids}`,
    kitchen: { id: 'kitchen-1', timeZone: 'America/Chicago', dayStart: '04:00' },
    rules: new Map(table.rows.map((row) => [row.id, row])),
    rulesVersion: table.rulesVersion,
    profile,
    ...extra,
  };
}

function line(overrides: Partial<ScreenEvent> = {}): ScreenEvent {
  return {
    id: 'line-45',
    kind: 'reading',
    occurredAt: LOGGED_AT,
    checkPointId: 'walk_in',
    measured: 'air',
    valueTenths: 450,
    promptKind: null,
    expiresAt: null,
    answered: false,
    corrections: 0,
    ...overrides,
  };
}

function openPrompt(overrides: Partial<ScreenEvent> = {}): ScreenEvent {
  return line({
    id: 'prompt-1',
    kind: 'wrong_number',
    valueTenths: null,
    promptKind: 'number_after_wrong',
    expiresAt: LOGGED_AT + profile.promptExpirySeconds * 1000,
    ...overrides,
  });
}

function wrongNumber(overrides: Partial<LogReadingInput> = {}): LogReadingInput {
  return { words: 'wrong number', initials: 'AB', screen_id: 'wall', request_id: 'request-2', ...overrides };
}

function correct(latest: ScreenEvent | null, now = LOGGED_AT + 30_000, input = wrongNumber()): Decided {
  const decision = decideCorrection(input, ctxAt(now), latest);
  if (decision.status !== 'decided') throw new Error(`expected a decided call, got ${decision.code}`);
  return decision;
}

// What a nothing_to_fix answer is made of: its reply and a receipt that points at nothing.
function replyShape(decision: Decided) {
  const { kind, refId, answersId, supersedesId, valueTenths } = decision.event;
  const { text } = decision.result.content[0];
  return { text, outcome: decision.result.structuredContent.outcome, kind, refId, answersId, supersedesId, valueTenths };
}

const NOTHING_TO_FIX_SHAPE = {
  text: NOTHING_TO_FIX,
  outcome: 'nothing_to_fix',
  kind: 'receipt',
  refId: null,
  answersId: null,
  supersedesId: null,
  valueTenths: null,
};

describe('decideCorrection', () => {
  describe('the window (E15)', () => {
    it('corrects a line exactly 120,000 ms old', () => {
      const decision = correct(line(), LOGGED_AT + WINDOW_MS);

      expect(decision.event).toMatchObject({ kind: 'wrong_number', refId: 'line-45', promptKind: 'number_after_wrong' });
    });

    it('answers a line 120,001 ms old with nothing to fix and a receipt', () => {
      expect(replyShape(correct(line(), LOGGED_AT + WINDOW_MS + 1))).toEqual(NOTHING_TO_FIX_SHAPE);
    });
  });

  it('answers a screen with no event in the window, such as one whose only line came from another screen, with nothing to fix (E16)', () => {
    expect(replyShape(correct(null))).toEqual(NOTHING_TO_FIX_SHAPE);
  });

  describe('a line said wrong', () => {
    it('stores a wrong_number event pointing at the line and asks for the number again', () => {
      const decision = correct(line());

      expect(decision.result.content[0].text).toBe('What does the walk-in read?');
      expect(decision.result.structuredContent).toMatchObject({
        outcome: 'held',
        checkPoint: { id: 'walk_in' },
        initials: 'AB',
        prompt: { kind: 'number_after_wrong', id: decision.event.id },
      });
      expect(decision.event).toMatchObject({
        kind: 'wrong_number',
        refId: 'line-45',
        answersId: null,
        supersedesId: null,
        checkPointId: 'walk_in',
        measured: 'air',
        initials: 'AB',
        valueTenths: null,
        words: 'wrong number',
        expiresAt: LOGGED_AT + 30_000 + profile.promptExpirySeconds * 1000,
      });
    });

    it('never uses a number sent beside the phrase', () => {
      const decision = correct(line(), undefined, wrongNumber({ words: "wrong number, it's 40", value: 40, check_point: 'walk_in' }));

      expect(decision.event).toMatchObject({ kind: 'wrong_number', valueTenths: null, refId: 'line-45' });
      expect(decision.result.structuredContent).not.toHaveProperty('value');
    });

    it('keeps a line stored with no measure as asked with none', () => {
      const decision = correct(line({ checkPointId: 'receiving', measured: null }));

      expect(decision.event).toMatchObject({ kind: 'wrong_number', checkPointId: 'receiving', measured: null });
      expect(decision.result.content[0].text).toBe('What does the delivery read?');
    });

    it('stores no initials on the wrong_number event when the call gives none', () => {
      const decision = correct(line(), undefined, wrongNumber({ initials: undefined }));

      expect(decision.event.initials).toBeNull();
      expect(decision.result.structuredContent).not.toHaveProperty('initials');
    });
  });

  // READ-05 counts a correction as the line that supersedes: 45 corrected to 40, 40 to 42, then a
  // third "wrong number" for that chain.
  it('answers the third correction of one chain "Log it by hand" with a receipt naming the line, and no prompt (E17)', () => {
    const decision = correct(line({ id: 'line-42', corrections: 2 }));

    expect(decision.result.content[0].text).toBe('Log it by hand.');
    expect(decision.result.structuredContent.outcome).toBe('refused');
    expect(decision.result.structuredContent).not.toHaveProperty('prompt');
    expect(decision.result.structuredContent).not.toHaveProperty('lineId');
    expect(decision.event).toMatchObject({ kind: 'receipt', refId: 'line-42', answersId: null, promptKind: null });
  });

  it('still asks after one confirmed correction', () => {
    expect(correct(line({ corrections: 1 })).event.kind).toBe('wrong_number');
  });

  describe('a question still open (E17)', () => {
    it('repeats the correction\'s question with the open prompt\'s id and a receipt that leaves it open', () => {
      const decision = correct(openPrompt());

      expect(decision.result.content[0].text).toBe('What does the walk-in read?');
      expect(decision.result.structuredContent).toMatchObject({ outcome: 'held', prompt: { kind: 'number_after_wrong', id: 'prompt-1' } });
      expect(decision.event).toMatchObject({ kind: 'receipt', refId: 'prompt-1', answersId: null, supersedesId: null, promptKind: null });
    });

    it('repeats it the same way a third and a fourth time, since a receipt is no wrong_number event', () => {
      const third = correct(openPrompt(), LOGGED_AT + 40_000);
      const fourth = correct(openPrompt(), LOGGED_AT + 50_000);

      for (const decision of [third, fourth]) {
        expect(decision.result.structuredContent.prompt).toEqual({ kind: 'number_after_wrong', id: 'prompt-1' });
        expect(decision.event).toMatchObject({ kind: 'receipt', refId: 'prompt-1', answersId: null });
      }
    });

    // Walk-in 45 logged, then reach-in 15 held for a digit repeat: the cook is correcting the number
    // Tolsey holds, never the walk-in line behind it.
    it('repeats a held digit repeat\'s question rather than correcting an older line', () => {
      const held = openPrompt({ id: 'hold-15', kind: 'held', checkPointId: 'reach_in_1', valueTenths: 150, promptKind: 'digit_repeat' });

      const decision = correct(held);

      expect(decision.result.content[0].text).toBe('Say it one digit at a time. What does reach-in one read?');
      expect(decision.result.structuredContent.prompt).toEqual({ kind: 'digit_repeat', id: 'hold-15' });
      expect(decision.event).toMatchObject({ kind: 'receipt', refId: 'hold-15' });
    });

    it('repeats "Who is logging?"', () => {
      const held = openPrompt({ kind: 'held', valueTenths: 380, promptKind: 'who_is_logging' });

      expect(correct(held).result.content[0].text).toBe('Who is logging?');
    });

    it('repeats "Which check reads 39?"', () => {
      const held = openPrompt({ kind: 'held', checkPointId: null, valueTenths: 390, promptKind: 'which_check' });

      const decision = correct(held);

      expect(decision.result.content[0].text).toBe('Which check reads 39?');
      expect(decision.result.structuredContent).not.toHaveProperty('checkPoint');
    });
  });

  describe('nothing left to correct', () => {
    it('never supersedes a refusal', () => {
      expect(replyShape(correct(openPrompt({ kind: 'refusal', promptKind: 'number' })))).toEqual(NOTHING_TO_FIX_SHAPE);
    });

    it('answers a hold whose question a "Log it by hand" receipt answered', () => {
      expect(replyShape(correct(openPrompt({ kind: 'held', promptKind: 'digit_repeat', answered: true })))).toEqual(NOTHING_TO_FIX_SHAPE);
    });

    it('answers a correction whose question has expired', () => {
      const expired = openPrompt();
      expect(replyShape(correct(expired, expired.expiresAt ?? 0))).toEqual(NOTHING_TO_FIX_SHAPE);
    });

    it('answers a hold whose stored question this code cannot ask', () => {
      expect(replyShape(correct(openPrompt({ kind: 'held', promptKind: 'toString' })))).toEqual(NOTHING_TO_FIX_SHAPE);
      expect(replyShape(correct(openPrompt({ kind: 'held', promptKind: 'which_check', valueTenths: null })))).toEqual(NOTHING_TO_FIX_SHAPE);
      expect(replyShape(correct(openPrompt({ kind: 'held', checkPointId: null, promptKind: 'digit_repeat' })))).toEqual(NOTHING_TO_FIX_SHAPE);
      expect(replyShape(correct(openPrompt({ kind: 'held', promptKind: null, expiresAt: null })))).toEqual(NOTHING_TO_FIX_SHAPE);
    });
  });
});

describe('a correction through decideLogReading', () => {
  function decide(input: LogReadingInput, extra: Partial<DecisionContext>): Decided {
    const decision = decideLogReading(input, ctxAt(LOGGED_AT + 30_000, extra));
    if (decision.status !== 'decided') throw new Error(`expected a decided call, got ${decision.code}`);
    return decision;
  }

  it.each(['wrong number', "That's wrong.", 'wrong reading, sorry'])('routes "%s" to the correction whatever else the call carries', (words) => {
    const decision = decide(wrongNumber({ words, value: 40, check_point: 'walk_in', pending_prompt_id: 'prompt-9' }), { latest: line() });

    expect(decision.event.kind).toBe('wrong_number');
  });

  it('refuses initials off the roster before any correction', () => {
    expect(decideLogReading(wrongNumber({ initials: 'ZZ' }), ctxAt(LOGGED_AT, { latest: line() }))).toEqual({
      status: 'rejected',
      code: 'initials_not_on_roster',
    });
  });

  it('answers "wrong number" with nothing to fix when the adapter read no event', () => {
    expect(replyShape(decide(wrongNumber(), {}))).toEqual(NOTHING_TO_FIX_SHAPE);
  });

  function answeredCorrectionPrompt(): PendingPrompt {
    return {
      id: 'prompt-1',
      promptKind: 'number_after_wrong',
      checkPointId: 'walk_in',
      measured: 'air',
      valueTenths: null,
      initials: 'AB',
      screenId: 'wall',
      expiresAt: LOGGED_AT + profile.promptExpirySeconds * 1000,
      refId: 'line-45',
      answered: true,
      repeats: 0,
      supersedes: { lineId: 'line-45', rootId: 'line-45', ruleSnapshot: null, rulesVersion: table.rulesVersion },
    };
  }

  it('keeps the already-answered reply for a prompt whose chain supersedes nothing', () => {
    const prompt = { ...answeredCorrectionPrompt(), promptKind: 'who_is_logging', supersedes: null };

    const decision = decide({ initials: 'MR', screen_id: 'wall', request_id: 'request-3', pending_prompt_id: 'prompt-1' }, { prompt });

    expect(decision.result.content[0].text).toMatch(/already answered/);
  });
});

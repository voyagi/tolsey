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
  // The offsets are written out, so a change to the demo window fails here rather than moving both
  // sides of the edge with it.
  describe('the window (E15)', () => {
    it('reads the window from the kitchen profile', () => {
      expect(WINDOW_MS).toBe(120000);
    });

    it('corrects a line exactly 120,000 ms old', () => {
      const decision = correct(line(), LOGGED_AT + 120000);

      expect(decision.event).toMatchObject({ kind: 'wrong_number', refId: 'line-45', promptKind: 'number_after_wrong' });
    });

    it('answers a line 120,001 ms old with nothing to fix and a receipt', () => {
      expect(replyShape(correct(line(), LOGGED_AT + 120001))).toEqual(NOTHING_TO_FIX_SHAPE);
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

    // A line always names a check point the profile holds; one that does not is a fault the adapter
    // answers with its fixed sentence, never a correction asked about a guessed check.
    it('throws for a line naming a check point the profile does not hold', () => {
      expect(() => correct(line({ checkPointId: 'retired_point' }))).toThrow(/check point missing/);
      expect(() => correct(line({ checkPointId: null }))).toThrow(/check point missing/);
    });

    it('stores no initials on the wrong_number event when the call gives none', () => {
      const decision = correct(line(), undefined, wrongNumber({ initials: undefined }));

      expect(decision.event.initials).toBeNull();
      expect(decision.result.structuredContent).not.toHaveProperty('initials');
    });
  });

  // READ-05 counts a correction as the line that supersedes: 45 corrected to 40, 40 to 42, then a
  // third "wrong number" for that chain. It still marks the line said wrong, so the check stays open,
  // but asks nothing: no prompt, and no line.
  it('answers the third correction of one chain "Log it by hand" with a wrong_number marker on the line that asks nothing (E17)', () => {
    const decision = correct(line({ id: 'line-42', corrections: 2 }));

    expect(decision.result.content[0].text).toBe('Log it by hand.');
    expect(decision.result.structuredContent).toMatchObject({ outcome: 'refused', checkPoint: { id: 'walk_in' }, initials: 'AB' });
    expect(decision.result.structuredContent).not.toHaveProperty('prompt');
    expect(decision.result.structuredContent).not.toHaveProperty('lineId');
    expect(decision.event).toMatchObject({
      kind: 'wrong_number',
      refId: 'line-42',
      answersId: null,
      supersedesId: null,
      outcome: 'refused',
      measured: 'air',
      valueTenths: null,
      promptKind: null,
      expiresAt: null,
    });
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
  });

  // Their answer logs the number the hold keeps, so asking them again would log the number said wrong.
  describe('a held question the number does not answer', () => {
    it('refuses the number held for "Who is logging?" with a refusal that answers the hold and asks for the number', () => {
      const held = openPrompt({ id: 'hold-38', kind: 'held', valueTenths: 380, promptKind: 'who_is_logging' });

      const decision = correct(held, undefined, wrongNumber({ initials: undefined }));

      expect(decision.result.content[0].text).toBe('I need the number on the thermometer. What does the walk-in read?');
      expect(decision.result.structuredContent).toMatchObject({
        outcome: 'refused',
        checkPoint: { id: 'walk_in' },
        prompt: { kind: 'number', id: decision.event.id },
      });
      expect(decision.event).toMatchObject({
        kind: 'refusal',
        answersId: 'hold-38',
        refId: null,
        supersedesId: null,
        checkPointId: 'walk_in',
        measured: 'air',
        valueTenths: null,
        promptKind: 'number',
      });
    });

    it('refuses the number held for "Which check reads 39?" and asks for a check and a number, opening no prompt', () => {
      const held = openPrompt({ id: 'hold-39', kind: 'held', checkPointId: null, measured: null, valueTenths: 390, promptKind: 'which_check' });

      const decision = correct(held);

      expect(decision.result.content[0].text).toBe('I need a check and the number on the thermometer.');
      expect(decision.result.structuredContent).not.toHaveProperty('checkPoint');
      expect(decision.result.structuredContent).not.toHaveProperty('prompt');
      expect(decision.event).toMatchObject({ kind: 'refusal', answersId: 'hold-39', checkPointId: null, promptKind: null, valueTenths: null });
    });
  });

  // The window bounds a line said wrong; a question is correctable for as long as it is open.
  it('refuses a held number said wrong after the window while a longer prompt expiry keeps its question open', () => {
    const longer = { ...profile, promptExpirySeconds: 300 };
    const held = openPrompt({ id: 'hold-38', kind: 'held', valueTenths: 380, promptKind: 'who_is_logging', expiresAt: LOGGED_AT + 300_000 });

    const decision = decideCorrection(wrongNumber(), ctxAt(LOGGED_AT + 200_000, { profile: longer }), held);

    expect(decision).toMatchObject({ status: 'decided', event: { kind: 'refusal', answersId: 'hold-38' } });
  });

  describe('nothing left to correct', () => {
    it('never supersedes a refusal', () => {
      expect(replyShape(correct(openPrompt({ kind: 'refusal', promptKind: 'number' })))).toEqual(NOTHING_TO_FIX_SHAPE);
    });

    it.each(['number_after_wrong', 'digit_repeat', 'who_is_logging'])(
      'never reads a refusal as an open question, even one storing a %s prompt',
      (promptKind) => {
        expect(replyShape(correct(openPrompt({ kind: 'refusal', promptKind })))).toEqual(NOTHING_TO_FIX_SHAPE);
      },
    );

    // A null expiry compares as 0, so only a clock before 1970 tells a stored null from an expiry long past.
    it('never reads a hold that stores no expiry as an open question, whatever the clock reads', () => {
      const held = openPrompt({ id: 'hold-15', kind: 'held', valueTenths: 150, promptKind: 'digit_repeat', expiresAt: null });
      for (const now of [LOGGED_AT + 30_000, -1]) {
        expect(replyShape(correct(held, now))).toEqual(NOTHING_TO_FIX_SHAPE);
      }
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
      supersedes: { lineId: 'line-45', rootId: 'line-45', ruleSnapshot: null, rulesVersion: table.rulesVersion, superseded: true },
    };
  }

  it("tells a second answer that the question was answered while the line said wrong stands uncorrected", () => {
    const prompt = answeredCorrectionPrompt();
    const held = { ...prompt, supersedes: prompt.supersedes && { ...prompt.supersedes, superseded: false } };

    const decision = decide({ value: 42, screen_id: 'wall', request_id: 'request-3', pending_prompt_id: 'prompt-1' }, { prompt: held });

    expect(decision.result.content[0].text).toMatch(/already answered/);
    expect(decision.event).toMatchObject({ kind: 'receipt', answersId: null, supersedesId: null });
  });

  // Fold recheck finding 5: the words a second number hears do not depend on whether it came later or
  // lost the race on the supersedes index.
  it("tells a later second number for a correction's prompt that the reading was already corrected", () => {
    const decision = decide({ value: 42, screen_id: 'wall', request_id: 'request-3', pending_prompt_id: 'prompt-1' }, { prompt: answeredCorrectionPrompt() });

    expect(decision.result.content[0].text).toMatch(/already corrected/);
    expect(decision.result.structuredContent).toMatchObject({ outcome: 'refused', checkPoint: { id: 'walk_in' } });
    expect(decision.event).toMatchObject({ kind: 'receipt', answersId: null, supersedesId: null });
  });

  it('keeps the already-answered reply for a prompt whose chain supersedes nothing', () => {
    const prompt = { ...answeredCorrectionPrompt(), promptKind: 'who_is_logging', supersedes: null };

    const decision = decide({ initials: 'MR', screen_id: 'wall', request_id: 'request-3', pending_prompt_id: 'prompt-1' }, { prompt });

    expect(decision.result.content[0].text).toMatch(/already answered/);
  });

  // Two "wrong number" calls racing on one line leave two questions about it. Once one is answered with
  // the corrected number, the other asks about a line already superseded: whatever answers it is told
  // so, and the receipt answers that question, so no hold or refusal can reopen the check.
  it.each([
    ['a number', { value: 39 }],
    ['a hedged number', { value: 40, words: 'about 40' }],
    ['no number', { words: 'the walk-in' }],
  ])('closes an open question about a line another question already corrected when %s answers it', (_, said) => {
    const open = { ...answeredCorrectionPrompt(), answered: false };

    const decision = decide({ ...said, screen_id: 'wall', request_id: 'request-3', pending_prompt_id: 'prompt-1' }, { prompt: open });

    expect(decision.result.content[0].text).toBe('That reading was already corrected. Say the check and its number again.');
    expect(decision.result.structuredContent).toMatchObject({ outcome: 'refused', checkPoint: { id: 'walk_in' } });
    expect(decision.event).toMatchObject({ kind: 'receipt', answersId: 'prompt-1', supersedesId: null });
  });

  // The snapshot is the stored copy of the row the line said wrong was judged by. One that no longer
  // reads as a temperature row, say a field renamed by a later table shape, faults instead of judging
  // the new number against a limit that is not there.
  it('judges a correction by a snapshot that reads as a temperature row, and faults on one that does not', () => {
    const row = table.rows.find((candidate) => candidate.id === 'unit_air_cold');
    if (row?.kind !== 'temperature') throw new Error('unit_air_cold is not a temperature row');
    const { limitFTenths, ...rest } = row;
    const openWith = (ruleSnapshot: string): PendingPrompt => ({
      ...answeredCorrectionPrompt(),
      answered: false,
      supersedes: { lineId: 'line-45', rootId: 'line-45', ruleSnapshot, rulesVersion: table.rulesVersion, superseded: false },
    });
    const call = { value: 40, screen_id: 'wall', request_id: 'request-3', pending_prompt_id: 'prompt-1' };

    const judged = decide(call, { prompt: openWith(JSON.stringify(row)) });
    const renamed = () => decideLogReading(call, ctxAt(LOGGED_AT + 30_000, { prompt: openWith(JSON.stringify({ ...rest, limitF: limitFTenths / 10 })) }));

    expect(judged.result.structuredContent).toMatchObject({ outcome: 'in_range', supersedesLineId: 'line-45' });
    expect(renamed).toThrow();
  });

  it("logs a correction's number under the rules version of the line it corrects", () => {
    const row = table.rows.find((candidate) => candidate.id === 'unit_air_cold');
    if (row?.kind !== 'temperature') throw new Error('unit_air_cold is not a temperature row');
    const open: PendingPrompt = {
      ...answeredCorrectionPrompt(),
      answered: false,
      supersedes: { lineId: 'line-45', rootId: 'line-45', ruleSnapshot: JSON.stringify(row), rulesVersion: '2026-09-01.1', superseded: false },
    };

    const decision = decide({ value: 40, screen_id: 'wall', request_id: 'request-3', pending_prompt_id: 'prompt-1' }, { prompt: open });

    expect(table.rulesVersion).not.toBe('2026-09-01.1');
    expect(decision.event).toMatchObject({ kind: 'reading', supersedesId: 'line-45', ruleId: 'unit_air_cold', rulesVersion: '2026-09-01.1' });
  });
});

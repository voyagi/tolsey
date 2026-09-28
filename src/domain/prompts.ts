import type { LogReadingInput } from '../contract/log-reading';
import type { PendingPrompt } from '../store/port';
import { TENTHS_PER_DEGREE, tenthsOf } from './decision';

// The facts an answer supplies once the prompt's held ones are filled in. Initials are in the
// roster's form already: the caller normalises them before the roster check.
interface PromptFill {
  checkPoint?: string;
  value?: number;
  measured?: string;
  initials?: string;
}

export type PromptResolution =
  | { kind: 'fresh' }
  | { kind: 'already_answered'; prompt: PendingPrompt }
  | {
      kind: 'answer';
      prompt: PendingPrompt;
      fill: PromptFill;
      // The value came from this call, so its words decide whether it is a reading at all; a held
      // value was already judged a number when it was held.
      valueFromCall: boolean;
      confirms: boolean;
    };

const ASKS_FOR_NUMBER: ReadonlySet<string> = new Set(['number', 'digit_repeat']);
const KNOWN_KINDS: ReadonlySet<string> = new Set([...ASKS_FOR_NUMBER, 'which_check', 'who_is_logging']);

function heldValue(prompt: PendingPrompt): number | undefined {
  return prompt.valueTenths === null ? undefined : prompt.valueTenths / TENTHS_PER_DEGREE;
}

function differs<T>(given: T | undefined, held: T | null): boolean {
  return given !== undefined && held !== null && given !== held;
}

// A call carrying something the prompt already holds, but different, is a new call: a new number said
// with the initials must never be dropped in favour of the held one, and a question about the reach-in
// is not answered by a walk-in reading.
function contradicts(prompt: PendingPrompt, input: LogReadingInput): boolean {
  if (differs(input.check_point, prompt.checkPointId) || differs(input.measured, prompt.measured)) return true;
  if (ASKS_FOR_NUMBER.has(prompt.promptKind) || input.value === undefined) return false;
  return tenthsOf(input.value) !== prompt.valueTenths;
}

function isFresh(prompt: PendingPrompt, input: LogReadingInput, now: number): boolean {
  if (!KNOWN_KINDS.has(prompt.promptKind)) return true;
  return prompt.screenId !== input.screen_id || now >= prompt.expiresAt || contradicts(prompt, input);
}

function fillFor(prompt: PendingPrompt, input: LogReadingInput): PromptFill {
  const shared = {
    measured: input.measured ?? prompt.measured ?? undefined,
    initials: input.initials ?? prompt.initials ?? undefined,
  };
  if (ASKS_FOR_NUMBER.has(prompt.promptKind)) {
    return { ...shared, checkPoint: prompt.checkPointId ?? undefined, value: input.value };
  }
  return { ...shared, checkPoint: input.check_point ?? prompt.checkPointId ?? undefined, value: heldValue(prompt) };
}

// Order matters: the fresh-call checks come before the already-answered one, so an expired prompt or
// a contradicting call is a new call even when the prompt was answered, and only an answer that would
// otherwise resolve it is told it came too late, whether it came later or lost a race.
export function resolvePrompt(prompt: PendingPrompt | null, input: LogReadingInput, now: number): PromptResolution {
  if (prompt === null || isFresh(prompt, input, now)) return { kind: 'fresh' };
  if (prompt.answered) return { kind: 'already_answered', prompt };
  const asksForNumber = ASKS_FOR_NUMBER.has(prompt.promptKind);
  // A digit repeat holds exactly one number, the last one said, and only that number confirms it; a
  // yes or a call with no value never does.
  const confirms =
    prompt.promptKind === 'digit_repeat' && input.value !== undefined && tenthsOf(input.value) === prompt.valueTenths;
  return { kind: 'answer', prompt, fill: fillFor(prompt, input), valueFromCall: asksForNumber, confirms };
}

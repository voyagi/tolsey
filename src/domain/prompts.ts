import type { LogReadingInput } from '../contract/log-reading';
import type { PendingPrompt } from '../store/port';
import { TENTHS_PER_DEGREE, tenthsOf, type PromptKind } from './decision';

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
    };

// Whether each kind of question is answered by the number itself. A kind missing here would make
// every answer to it a fresh call without a word, so the table is typed by PromptKind: a kind added
// to that union fails the type check until it is placed here.
const ANSWERED_BY_NUMBER: Readonly<Record<PromptKind, boolean>> = {
  number: true,
  digit_repeat: true,
  which_check: false,
  who_is_logging: false,
  number_after_wrong: true,
};

// The stored kind is a string from the database, so an unknown one is a question this code cannot
// answer, and a call naming it is a fresh call.
function isKnownKind(kind: string): kind is PromptKind {
  return Object.hasOwn(ANSWERED_BY_NUMBER, kind);
}

function asksForNumber(kind: string): boolean {
  return isKnownKind(kind) && ANSWERED_BY_NUMBER[kind];
}

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
  if (asksForNumber(prompt.promptKind) || input.value === undefined) return false;
  return tenthsOf(input.value) !== prompt.valueTenths;
}

function isFresh(prompt: PendingPrompt, input: LogReadingInput, now: number): boolean {
  if (!isKnownKind(prompt.promptKind)) return true;
  return prompt.screenId !== input.screen_id || now >= prompt.expiresAt || contradicts(prompt, input);
}

function fillFor(prompt: PendingPrompt, input: LogReadingInput): PromptFill {
  const shared = {
    measured: input.measured ?? prompt.measured ?? undefined,
    initials: input.initials ?? prompt.initials ?? undefined,
  };
  if (asksForNumber(prompt.promptKind)) {
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
  // Whether a digit repeat is confirmed depends on the number its words give, which the decision reads.
  return { kind: 'answer', prompt, fill: fillFor(prompt, input), valueFromCall: asksForNumber(prompt.promptKind) };
}

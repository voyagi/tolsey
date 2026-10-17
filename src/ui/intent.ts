import type { KitchenProfile } from '../domain/rule';
import { DIGIT_OF_WORD, joinDigits, namedInWords, partsWithoutNames, saysCorrection, tokensOf } from '../domain/words';
import { LOCAL_REPLY } from './wall-copy';

export type OpenPrompt = { kind: string; id: string };

export type Intent =
  | { kind: 'none' }
  | { kind: 'local_reply'; text: string }
  | { kind: 'call'; args: { check_point?: string; value?: number; words: string; pending_prompt_id?: string } };

// At most one decimal place, as the tool accepts, so "41.45" and "38.50" are no figure at all.
const FIGURE = /^-?\d+(\.\d)?$/;

function onlyOne<T>(items: readonly T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

// Only an answer may spell its number one digit at a time, as the digit repeat asks the cook to; outside
// a question number words are not read at all, so "one five" alone names no figure.
function figureParts(tokens: readonly string[], profile: KitchenProfile, openPrompt: OpenPrompt | null): string[] {
  const parts = partsWithoutNames(tokens, profile);
  return openPrompt === null ? parts : joinDigits(parts.map((part) => DIGIT_OF_WORD.get(part) ?? part));
}

// The words go out exactly as given: the server judges them beside the value, so cleaning them up
// here could turn a hedge into a reading.
export function intentFor(text: string, profile: KitchenProfile, openPrompt: OpenPrompt | null): Intent {
  if (text.trim() === '') return { kind: 'none' };
  const tokens = tokensOf(text);
  const checkPoint = onlyOne([...namedInWords(tokens, profile).checkPoints]);
  const figure = onlyOne(figureParts(tokens, profile, openPrompt).filter((part) => FIGURE.test(part)));
  // With nothing to log and no question to answer, a call would only store an empty refusal. A
  // correction names neither, because only the record knows which line it is about.
  if (openPrompt === null && checkPoint === undefined && figure === undefined && !saysCorrection(text, profile)) {
    return { kind: 'local_reply', text: LOCAL_REPLY };
  }
  return {
    kind: 'call',
    args: {
      ...(checkPoint === undefined ? {} : { check_point: checkPoint }),
      ...(figure === undefined ? {} : { value: Number(figure) }),
      words: text,
      ...(openPrompt === null ? {} : { pending_prompt_id: openPrompt.id }),
    },
  };
}

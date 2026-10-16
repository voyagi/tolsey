import type { KitchenProfile } from '../domain/rule';
import { namedInWords, partsWithoutNames, tokensOf } from '../domain/words';

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

// The words go out exactly as given: the server judges them beside the value, so cleaning them up
// here could turn a hedge into a reading.
export function intentFor(text: string, profile: KitchenProfile, openPrompt: OpenPrompt | null): Intent {
  if (text.trim() === '') return { kind: 'none' };
  const tokens = tokensOf(text);
  const checkPoint = onlyOne([...namedInWords(tokens, profile).checkPoints]);
  const figure = onlyOne(partsWithoutNames(tokens, profile).filter((part) => FIGURE.test(part)));
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

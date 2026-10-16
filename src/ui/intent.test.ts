import { describe, expect, it } from 'vitest';
import { PHRASE_TABLE } from '../test-support/phrase-table';
import { intentFor } from './intent';
import { WALL_PROFILE } from './profile';
import { TAUGHT_PHRASES } from './wall-copy';

function promptLabel(openPrompt: { kind: string } | null): string {
  return openPrompt === null ? 'no question open' : `a ${openPrompt.kind} question open`;
}

describe('the intent rule for every phrase in the table', () => {
  it.each(PHRASE_TABLE.map((row) => ({ ...row, label: promptLabel(row.openPrompt) })))(
    'reads $phrase with $label as $expected.kind',
    ({ phrase, openPrompt, expected }) => {
      const intent = intentFor(phrase, WALL_PROFILE, openPrompt);
      expect(intent.kind).toBe(expected.kind);
      expect(intent).toStrictEqual(expected);
    },
  );
});

describe('the words go out as typed', () => {
  it('sends args.words equal to the phrase byte for byte on every row that makes a call', () => {
    const calls = PHRASE_TABLE.filter((row) => row.expected.kind === 'call');
    expect(calls.length).toBeGreaterThan(0);
    for (const { phrase, openPrompt } of calls) {
      const intent = intentFor(phrase, WALL_PROFILE, openPrompt);
      expect(intent.kind === 'call' ? intent.args.words : undefined).toBe(phrase);
    }
  });
});

describe('every phrase the page teaches', () => {
  it.each(TAUGHT_PHRASES)('has a phrase-table row read with no question open: %s', (phrase) => {
    expect(PHRASE_TABLE.some((row) => row.phrase === phrase && row.openPrompt === null)).toBe(true);
  });
});

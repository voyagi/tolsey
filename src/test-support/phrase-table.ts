import type { Intent, OpenPrompt } from '../ui/intent';
import { LOCAL_REPLY } from '../ui/wall-copy';

interface PhraseRow {
  phrase: string;
  openPrompt: OpenPrompt | null;
  expected: Intent;
}

type CallArgs = Omit<Extract<Intent, { kind: 'call' }>['args'], 'words'>;

const DIGIT_REPEAT: OpenPrompt = { kind: 'digit_repeat', id: 'prompt-digit-repeat' };
const NUMBER: OpenPrompt = { kind: 'number', id: 'prompt-number' };

function call(phrase: string, args: CallArgs, openPrompt: OpenPrompt | null = null): PhraseRow {
  return { phrase, openPrompt, expected: { kind: 'call', args: { ...args, words: phrase } } };
}

function localReply(phrase: string): PhraseRow {
  return { phrase, openPrompt: null, expected: { kind: 'local_reply', text: LOCAL_REPLY } };
}

function noCall(phrase: string): PhraseRow {
  return { phrase, openPrompt: null, expected: { kind: 'none' } };
}

// Shared by the intent test and the render test, so a phrase the page shows is held to the same
// expected call the intent rule is.
export const PHRASE_TABLE: readonly PhraseRow[] = [
  call('the walk-in reads 38', { check_point: 'walk_in', value: 38 }),
  call('the soup well reads 120', { check_point: 'soup_well', value: 120 }),
  call('reach-in two is fine', { check_point: 'reach_in_2' }),
  call('the walk-in is under 41', { check_point: 'walk_in', value: 41 }),
  call('walk-in 15', { check_point: 'walk_in', value: 15 }),
  call('walk-in freezer 0', { check_point: 'freezer', value: 0 }),
  call('The Walk-In reads 38.', { check_point: 'walk_in', value: 38 }),
  call('38 on the walk-in', { check_point: 'walk_in', value: 38 }),
  call('freezer reads -5', { check_point: 'freezer', value: -5 }),
  noCall(''),
  noCall('   '),
  call('walk-in 41.45', { check_point: 'walk_in' }),
  localReply('38.50'),
  localReply('hello'),
  call('38 or 39 walk-in', { check_point: 'walk_in' }),
  call('wrong number', {}),
  call("that's wrong", {}),
  call('Wrong reading.', {}),
  localReply('wrong'),
  localReply('one five'),
  call('1 5', { value: 15, pending_prompt_id: DIGIT_REPEAT.id }, DIGIT_REPEAT),
  call('one five', { value: 15, pending_prompt_id: DIGIT_REPEAT.id }, DIGIT_REPEAT),
  call('it reads one five', { value: 15, pending_prompt_id: DIGIT_REPEAT.id }, DIGIT_REPEAT),
  // A digit word beside a whole number word is part of that number, never a digit of its own.
  call('twenty one', { pending_prompt_id: NUMBER.id }, NUMBER),
  call('fifteen two', { pending_prompt_id: DIGIT_REPEAT.id }, DIGIT_REPEAT),
  call('one hundred', { pending_prompt_id: NUMBER.id }, NUMBER),
  call('38', { value: 38, pending_prompt_id: NUMBER.id }, NUMBER),
  call("it's fine", { pending_prompt_id: NUMBER.id }, NUMBER),
  call('the walk-in reads 38', { check_point: 'walk_in', value: 38, pending_prompt_id: NUMBER.id }, NUMBER),
];

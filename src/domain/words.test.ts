import { describe, expect, it } from 'vitest';
import demoJson from '../../data/kitchens/demo.json';
import { KitchenProfileSchema } from './rule';
import { classifyNumberWords, rebuildWords, tokensOf } from './words';

const profile = KitchenProfileSchema.parse(demoJson);
const walkIn = profile.checkPoints.find((point) => point.id === 'walk_in');

function classify(words: string) {
  return classifyNumberWords(tokensOf(words), profile);
}

describe('classifyNumberWords', () => {
  it.each([
    'under 41',
    'below forty',
    'below 5',
    'under 5',
    'over 5',
    'below zero',
    'about 40',
    'high thirties',
    '38 or 39',
    'same as before',
    "it's cold",
    'the walk-in is under 41',
  ])('classifies "%s" as a hedge', (words) => {
    expect(classify(words)).toEqual({ kind: 'hedge' });
  });

  // Limits, ranges and guesses beyond the spec's examples: each one would otherwise store the number
  // the host put beside it as a judged reading (N1).
  it.each([
    'at most 41',
    'at least 135',
    'up to 41',
    'max 41',
    '41 tops',
    '41 or lower',
    'higher than 135',
    '40 or so',
    'give or take 40',
    'close to 40',
    'near 40',
    'approx. 40',
    'probably 40',
    'i think 40',
    'like 40',
    '30 something',
    'same as always',
    'between 38 and 40',
    '38-40',
    '38.5-39',
    'mid-30s',
    'high-thirties',
    '38ish',
    '38-ish',
    'forty-ish',
  ])('classifies "%s" as a hedge', (words) => {
    expect(classify(words)).toEqual({ kind: 'hedge' });
  });

  // "below" after a number is a sign only when nothing but the zero word follows it; before a limit
  // it compares the reading with that limit, which is not a reading below zero.
  it.each(['the walk-in is 38, below 41', '38 below 41', 'freezer 2 below the limit', '38 degrees below 41'])(
    'classifies "%s" as a hedge, never as a number below zero',
    (words) => {
      expect(classify(words)).toEqual({ kind: 'hedge' });
    },
  );

  it.each([
    '5 below',
    '5 below zero',
    '5 below 0',
    'the freezer reads 5 below',
    '5-below',
    'minus 5',
    'the freezer reads negative 5',
    'freezer minus 5 degrees',
    '5 degrees below zero',
    'the freezer is 5 degrees below',
  ])('reads "%s" as 5 below zero', (words) => {
    expect(classify(words)).toEqual({ kind: 'negative', magnitude: 5 });
  });

  it('reads a sign word before a number said in words as below zero, of the magnitude the value gives', () => {
    expect(classify('the freezer reads minus five')).toEqual({ kind: 'negative', magnitude: undefined });
  });

  it('classifies a sign word standing apart from the figure said as a hedge', () => {
    expect(classify('minus uh 5')).toEqual({ kind: 'hedge' });
    expect(classify('negative on the door, walk-in 38')).toEqual({ kind: 'hedge' });
  });

  it.each([
    'the walk-in reads 38',
    'walk-in 38.5',
    'soup well 168',
    '',
    'the reach-in 2 reads 40',
    'walk-in cooler is at 38',
    'delivery came in at 38',
    '-5',
  ])('classifies "%s" as plain', (words) => {
    expect(classify(words)).toEqual({ kind: 'plain' });
  });

  it('treats a state word beside the number itself as plain', () => {
    expect(classify('the walk-in is fine at 38')).toEqual({ kind: 'plain' });
  });

  // "cool down" is an alias of the cooling check point, so its "cool" names the check, not its state.
  it('reads a state word inside a check point name as the name, never as a verdict', () => {
    expect(classify('the cool down reads forty')).toEqual({ kind: 'plain' });
    expect(classify('the cool down is cool')).toEqual({ kind: 'hedge' });
  });

  // The digit in "reach-in 2" names the check, so it is never the number the cook said.
  it.each(['the reach-in 2 is fine', 'reach-in 1 is good'])(
    'reads a digit inside a check point name as the name: "%s" is a hedge',
    (words) => {
      expect(classify(words)).toEqual({ kind: 'hedge' });
    },
  );
});

describe('rebuildWords on a refused line', () => {
  it.each([
    ['the reach-in is fine', 'the reach-in is fine'],
    ['the walk-in is under 41', 'the walk-in is under 41'],
    ['about 40', 'about 40'],
    ['high thirties', 'high thirties'],
    ['38 or 39', '38 or 39'],
    ['same as before', 'same as before'],
    ["it's cold", "its cold"],
  ])('quotes "%s" from its recognised words', (said, stored) => {
    expect(rebuildWords(said, profile, undefined, walkIn)).toBe(stored);
  });

  it('still drops markup, long digit runs and words outside the vocabulary', () => {
    expect(rebuildWords('<b>the walk-in</b> is under 41 call 5551234567 ünïcode', profile, undefined, walkIn)).toBe(
      'the walk-in is under 41',
    );
  });

  // A limit or a range needs two figures at most, each one a thermometer could show, so digits said in
  // groups, such as a phone or card number, never persist whole.
  it('keeps at most two figures of up to three digits', () => {
    expect(rebuildWords('call 555 123 4567', profile, undefined, walkIn)).toBe('555 123');
    expect(rebuildWords('card 1234 5678 9012 3456', profile, undefined, walkIn)).toBe('walk-in');
    expect(rebuildWords('between 38 and 40', profile, undefined, walkIn)).toBe('between 38 40');
  });

  // The digits of "reach-in 1" and "reach-in 2" are name words, so outside a name they count as figures.
  it('counts a digit a name also holds as a figure outside that name, and keeps the name whole', () => {
    expect(rebuildWords('1 2 1 1 2 2 1 2 1 2', profile, undefined, walkIn)).toBe('1 2');
    expect(rebuildWords('the reach-in 2 is 38 or 39', profile, undefined, walkIn)).toBe('the reach-in 2 is 38 or 39');
  });
});

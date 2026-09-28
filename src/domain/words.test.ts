import { describe, expect, it } from 'vitest';
import demoJson from '../../data/kitchens/demo.json';
import { KitchenProfileSchema } from './rule';
import { classifyNumberWords, rebuildWords, tokensOf } from './words';

const profile = KitchenProfileSchema.parse(demoJson);
const walkIn = profile.checkPoints.find((point) => point.id === 'walk_in');

function classify(words: string) {
  return classifyNumberWords(tokensOf(words), profile.vocabulary);
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

  it.each(['5 below', '5 below zero', 'the freezer reads 5 below'])('reads "%s" as the negative number -5', (words) => {
    expect(classify(words)).toEqual({ kind: 'negative', value: -5 });
  });

  it.each(['the walk-in reads 38', 'walk-in 38.5', 'soup well 168', ''])('classifies "%s" as plain', (words) => {
    expect(classify(words)).toEqual({ kind: 'plain' });
  });

  it('treats a state word beside the number itself as plain', () => {
    expect(classify('the walk-in is fine at 38')).toEqual({ kind: 'plain' });
  });
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
});

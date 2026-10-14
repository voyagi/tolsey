import { describe, expect, it } from 'vitest';
import demoJson from '../../data/kitchens/demo.json';
import { KitchenProfileSchema } from './rule';
import {
  answerNumberWords,
  classifyNumberWords,
  namedInWords,
  namesAnotherFigure,
  namesAnotherMagnitude,
  rebuildWords,
  saysCorrection,
  tokensOf,
} from './words';

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
    '38.5ish',
    '38.25ish',
  ])('classifies "%s" as a hedge', (words) => {
    expect(classify(words)).toEqual({ kind: 'hedge' });
  });

  // Each piece of a hyphenated token is read on its own, and a dash between two digit figures is a
  // range wherever it stands in the token: otherwise "40ish" after the split hides as one word.
  it.each(['38-40ish', '38ish-40', 'the walk-in reads 38-40-ish', '38-40-42', '38.25-40.75', '38-40.5'])(
    'classifies the hyphenated "%s" as a hedge',
    (words) => {
      expect(classify(words)).toEqual({ kind: 'hedge' });
    },
  );

  it.each(['thirty-eight', 'the walk-in reads 38', 'walk-in 38'])('classifies the hyphenated or plain "%s" as plain', (words) => {
    expect(classify(words)).toEqual({ kind: 'plain' });
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
    expect(classify(words)).toEqual({ kind: 'negative' });
    expect(namesAnotherMagnitude(tokensOf(words), profile, 5)).toBe(false);
    expect(namesAnotherMagnitude(tokensOf(words), profile, 6)).toBe(true);
  });

  it('reads a sign word before a number said in words as below zero, of the magnitude the value gives', () => {
    expect(classify('the freezer reads minus five')).toEqual({ kind: 'negative' });
    expect(namesAnotherMagnitude(tokensOf('the freezer reads minus five'), profile, 7)).toBe(false);
  });

  it.each(['0 below', 'minus 0', 'the freezer reads -0', 'minus zero', 'the freezer reads negative zero'])(
    'reads "%s" as a plain zero, since zero takes no sign',
    (words) => {
      expect(classify(words)).toEqual({ kind: 'plain' });
    },
  );

  it('still reads "minus zero" beside a figure in digits as a sign standing apart from it', () => {
    expect(classify('minus zero, walk-in 38')).toEqual({ kind: 'hedge' });
  });

  // A zero after a sign, in digits or in words, with more figures after it, does not say which figure
  // the sign belongs to, the way "minus uh 5" does not.
  it.each([
    'the freezer reads minus 0 point 5',
    'the freezer reads -0 point 5',
    'the freezer reads minus zero point five',
    'the freezer reads minus zero, five minutes ago',
  ])('classifies "%s" as a hedge', (words) => {
    expect(classify(words)).toEqual({ kind: 'hedge' });
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

  it.each(['here', 'was', 'there'])('finds the one-word hedge phrase "%s" only in a call that says it', (phrase) => {
    const { hedges } = demoJson.vocabulary;
    const withPhrase = KitchenProfileSchema.parse({
      ...demoJson,
      vocabulary: { ...demoJson.vocabulary, hedges: { ...hedges, phrases: [...hedges.phrases, phrase] } },
    });
    expect(classifyNumberWords(tokensOf('the walk-in reads 38'), withPhrase)).toEqual({ kind: 'plain' });
    expect(classifyNumberWords(tokensOf(`the walk-in reads 38 ${phrase}`), withPhrase)).toEqual({ kind: 'hedge' });
  });

  it('matches a hedge phrase as whole words, never inside a longer word: "here" is not in "there"', () => {
    const { hedges } = demoJson.vocabulary;
    const withHere = KitchenProfileSchema.parse({
      ...demoJson,
      vocabulary: { ...demoJson.vocabulary, hedges: { ...hedges, phrases: [...hedges.phrases, 'here'] } },
    });
    expect(classifyNumberWords(tokensOf('the walk-in reads 38 there'), withHere)).toEqual({ kind: 'plain' });
  });
});

// Written to break the classifier: the shapes a host's transcript can take that the cases above do
// not. A range or limit must never read as the number beside it, and a reading must never be refused
// for its punctuation.
describe('classifyNumberWords against transcript shapes', () => {
  it.each([
    ['38\u201340', 'an en dash range'],
    ['38\u201440', 'an em dash range'],
    ['38 - 40', 'a spaced hyphen range'],
    ['38 through 40', 'a through range'],
    ['38 thru 40', 'a thru range'],
    ['41°F or less', 'a degree sign before a limit'],
    ['no more than 41', 'a limit in a longer phrase'],
  ])('classifies "%s" (%s) as a hedge', (words) => {
    expect(classify(words)).toEqual({ kind: 'hedge' });
  });

  // A range said in number words is still a range, so it is never logged as the value beside it.
  it.each([
    ['the walk-in reads thirty eight or thirty nine', 'both ends in words'],
    ['thirty-eight to forty', 'hyphenated words'],
    ['38 or thirty nine', 'a figure then words'],
    ['thirty eight through 40', 'words then a figure'],
    ['fifteen or fifty', 'a teen and its ten'],
    ['one thirty five to one forty', 'hot-holding figures in words'],
  ])('classifies "%s" (%s) as a hedge', (words) => {
    expect(classify(words)).toEqual({ kind: 'hedge' });
  });

  it.each([
    ['the walk-in reads thirty eight', 'one figure in words'],
    ['delivery came in to thirty eight', 'a range word with no figure before it'],
    ['log 38 to the walk-in', 'a range word with no figure after it'],
    ['the reach-in one reads forty', 'a number word inside a check point name'],
    ['the low boy reads 38', 'a decade word before a word, not a figure'],
  ])('classifies "%s" (%s) as plain', (words) => {
    expect(classify(words)).toEqual({ kind: 'plain' });
  });

  // A decade word before a figure places the reading somewhere in that decade, never at the figure.
  it.each(['mid 35', 'high 40', 'low 38', 'the walk-in is in the mid thirty five', 'lower 40', 'the walk-in is upper 30'])('classifies "%s" as a hedge', (words) => {
    expect(classify(words)).toEqual({ kind: 'hedge' });
  });

  // At hot holding the limit sits inside a three-digit decade: "the 130s" straddles 135.
  it.each([
    'the soup well is in the 130s',
    'soup well high 130s',
    'soup well mid-130s',
    'carving station low 100s',
    'the walk-in is in the teens',
  ])('classifies "%s", a decade of any width, as a hedge', (words) => {
    expect(classify(words)).toEqual({ kind: 'hedge' });
  });

  it('classifies every decade word in the vocabulary before a figure as a hedge', () => {
    for (const word of profile.vocabulary.hedges.decades) {
      expect(classify(`${word} 41`), `${word} 41`).toEqual({ kind: 'hedge' });
    }
  });

  it.each([
    ['\u22125', 'a true minus sign'],
    ['the freezer reads \u20135', 'an en dash as a minus'],
    ['the freezer reads -5', 'a hyphen as a minus'],
    ['5 degree below zero', 'the singular unit word'],
  ])('reads "%s" (%s) as 5 below zero', (words) => {
    expect(classify(words)).toEqual({ kind: 'negative' });
    expect(namesAnotherMagnitude(tokensOf(words), profile, 5)).toBe(false);
    expect(namesAnotherMagnitude(tokensOf(words), profile, 6)).toBe(true);
  });

  it.each([
    ['38 1/2', 'a fraction beside the figure'],
    ['the reach-in two is at 40', 'a check point named in words'],
    ['walk-in: 38!', 'punctuation around the figure'],
  ])('classifies "%s" (%s) as plain', (words) => {
    expect(classify(words)).toEqual({ kind: 'plain' });
  });

  it('refuses a state said about a check point whose name holds no digit', () => {
    expect(classify('the reach-in two is fine')).toEqual({ kind: 'hedge' });
  });

  // A token of dashes alone is a range however many dashes it holds; a dash on one side of a word is
  // no range, and the word keeps its meaning.
  it.each([
    ['38 -- 40', 'a doubled dash standing alone'],
    ['high--40', 'a doubled dash inside a token'],
    ['high- 40', 'a dash closing a decade word'],
    ['38 -ish', 'a dash opening an approximation'],
  ])('classifies "%s" (%s) as a hedge', (words) => {
    expect(classify(words)).toEqual({ kind: 'hedge' });
  });

  // Every limit and approximation word, before or after a figure, is a hedge; "below" after a figure
  // is the one exception, the sign.
  it('classifies every limit and approximation word in the vocabulary as a hedge on either side of a figure', () => {
    const { hedges } = profile.vocabulary;
    const words = [...hedges.limits, ...hedges.approximations].filter((word) => word !== hedges.below);
    for (const word of words) {
      expect(classify(`${word} 41`), `${word} 41`).toEqual({ kind: 'hedge' });
      expect(classify(`41 ${word}`), `41 ${word}`).toEqual({ kind: 'hedge' });
    }
    expect(classify(`${hedges.below} 41`)).toEqual({ kind: 'hedge' });
  });

  // A host writing the call can put a limit or a guess as a symbol. Read as plain, "<41" would log 41.
  it.each(['<41', 'walk-in < 41', '>135', '~38', '\u224838', '38+', '\u226441', '\u2265135'])(
    'classifies the symbol beside the figure in "%s" as a hedge',
    (words) => {
      expect(classify(words)).toEqual({ kind: 'hedge' });
    },
  );

  // Markup around a word is no limit: its brackets stand beside no figure.
  it('classifies a reading wrapped in markup as plain', () => {
    expect(classify('<b>the walk-in</b> reads 38')).toEqual({ kind: 'plain' });
  });

  // A bracket touching a figure cannot be told from a limit, so markup round the figure refuses.
  it('classifies markup wrapped round the figure itself as a hedge', () => {
    expect(classify('the walk-in reads <b>38</b>')).toEqual({ kind: 'hedge' });
  });
});

// An answer to which check or who is logging repeats a number already held, so only a hedge or a sign
// in its words says anything about it.
describe('answerNumberWords', () => {
  function answer(words: string) {
    return answerNumberWords(tokensOf(words), profile);
  }

  it.each(['MR, about 38', 'MR, high 30s', 'the walk-in, thirty nine or forty'])('reads "%s" as a hedge', (words) => {
    expect(answer(words)).toEqual({ kind: 'hedge' });
  });

  it('reads "MR, 5 below" as 5 below zero', () => {
    expect(answer('MR, 5 below')).toEqual({ kind: 'negative' });
    expect(namesAnotherMagnitude(tokensOf('MR, 5 below'), profile, 5)).toBe(false);
  });

  it.each(['MR, minus zero', 'MR, 0 below'])('reads "%s" as a plain zero, since zero takes no sign', (words) => {
    expect(answer(words)).toEqual({ kind: 'plain' });
  });

  // Unlike a fresh call, a state word here answers the question and never refuses the held number.
  it.each(['MR', "MR, it's fine", 'the walk-in', 'MR, 38'])('reads "%s" as saying nothing new', (words) => {
    expect(answer(words)).toEqual({ kind: 'plain' });
  });
});

// Written to break the comparison: each pair is a spelling of the value that must pass, or a figure
// beside it that is another number and must not.
describe('namesAnotherFigure', () => {
  function another(words: string, value: number): boolean {
    return namesAnotherFigure(tokensOf(words), profile, value);
  }

  it.each([
    ['the walk-in reads 38', 38],
    ['the walk-in reads 38.0', 38],
    ['the walk-in reads 38 and a half', 38.5],
    ['the walk-in reads 38 point 5', 38.5],
    ['the walk-in reads 3 8 point 5', 38.5],
    ['the walk-in reads 38 point five', 38.5],
    ['the walk-in reads 38 point 0', 38],
    ['the walk-in reads 38 point zero', 38],
    ['the walk-in reads 41 degrees', 41],
    ['the walk-in reads 1 5', 15],
    ['1 5', 15],
    ['the reach-in 2 reads 38', 38],
    ['the walk-in reads thirty nine', 38],
    ['the freezer reads zero', 0],
    ['the freezer reads zero point 5', 0.5],
    ['the freezer reads zero point five', 0.5],
    ['the walk-in is fine', 38],
  ])('passes "%s" beside %d', (words, value) => {
    expect(another(words, value)).toBe(false);
  });

  it.each([
    ['the walk-in reads 38', 39],
    ['the walk-in reads 41', 41.5],
    ['the walk-in reads 41 degrees', 41.9],
    ['the walk-in reads 38.5', 38],
    ['the walk-in reads 38 and a half', 39],
    ['the walk-in reads 38 and a half', 38.9],
    ['the walk-in reads 38 and a half', 38],
    ['the walk-in reads 38 point 5', 38],
    ['the walk-in reads 38 point 5', 5],
    ['the walk-in reads 38 point five', 38],
    ['the walk-in reads 38 point five five', 38.5],
    ['the walk-in reads 38 point fifty', 38],
    ['the walk-in reads 38 point', 38],
    ['the walk-in reads 38.5 and a half', 38.5],
    ['the walk-in reads 38 and 7', 38.5],
    ['the walk-in reads 38, 5 minutes ago', 38],
    ['the walk-in reads 38, 5 minutes ago', 5],
    ['the walk-in reads 38 5', 385],
    ['the walk-in reads 1 5', 16],
    ['1 5', 16],
    ['the walk-in shelf 2 reads 38', 38],
    ['the freezer reads minus zero', 5],
    ['the freezer reads zero point five', -0.5],
  ])('refuses "%s" beside %d', (words, value) => {
    expect(another(words, value)).toBe(true);
  });
});

// Words that say a reading below zero give the sign apart from the figure, so each figure is held to
// the value's size: a spelling of that size passes, and any other figure beside it refuses.
describe('namesAnotherMagnitude', () => {
  function another(words: string, magnitude: number): boolean {
    return namesAnotherMagnitude(tokensOf(words), profile, magnitude);
  }

  it.each([
    ['the freezer reads minus 5', 5],
    ['the freezer reads -5', 5],
    ['the freezer is 5 degrees below zero', 5],
    ['the freezer is 5 below 0', 5],
    ['the freezer reads minus five, two minutes ago', 5],
    ['the freezer reads minus 5 point 5', 5.5],
    ['the freezer reads -5 point 5', 5.5],
    ['the freezer reads minus 5 and a half', 5.5],
    ['the freezer reads minus 1 5', 15],
    ['the walk-in freezer reads minus 5', 5],
  ])('passes "%s" beside the size %d', (words, magnitude) => {
    expect(another(words, magnitude)).toBe(false);
  });

  it.each([
    ['the freezer reads minus 5 and 7', 5],
    ['the freezer reads minus 5, 2 minutes ago', 5],
    ['the freezer reads -5, 2 minutes ago', 5],
    ['the freezer reads minus 5 point 5', 5],
    ['the freezer reads -5 point 5', 5],
    ['the freezer reads minus 5 and a half', 5],
    ['the freezer reads minus 1 5', 1],
    ['the freezer is 5 degrees below zero', 7],
    ['the freezer is 5 below 0, 2 minutes ago', 5],
  ])('refuses "%s" beside the size %d', (words, magnitude) => {
    expect(another(words, magnitude)).toBe(true);
  });
});

describe('namedInWords', () => {
  function named(words: string): { checkPoints: string[]; measured: string[] } {
    const found = namedInWords(tokensOf(words), profile);
    return { checkPoints: [...found.checkPoints].sort(), measured: [...found.measured].sort() };
  }

  it.each([
    ['the walk-in reads 38', ['walk_in'], []],
    ['the walk-in freezer reads 5', ['freezer'], []],
    ['the soup well reads 140', ['soup_well'], []],
    ['the chicken soup at the carving station', ['carving_station'], ['chicken_soup']],
    ['the chicken reads 38', [], ['raw_chicken']],
    ['the chili and chicken soup read 140', [], ['catered_chili', 'chicken_soup']],
    ['reach in one and reach-in 2', ['reach_in_1', 'reach_in_2'], []],
    ['the walk-in air temperature reads 38', ['walk_in'], ['air']],
    ['well, the walk-in reads 38', ['walk_in'], []],
    ['it reads 38', [], []],
  ])('finds in "%s" the check points %j and the measured %j', (words, checkPoints, measured) => {
    expect(named(words)).toEqual({ checkPoints, measured });
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
    ['walk in cooler is fine', 'walk in cooler is fine'],
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

  it('keeps a digit decade a name holds only inside that name', () => {
    const withDecade = KitchenProfileSchema.parse({
      ...demoJson,
      checkPoints: demoJson.checkPoints.map((point) => (point.id === 'walk_in' ? { ...point, aliases: [...point.aliases, 'box 40s'] } : point)),
    });

    expect(rebuildWords('walk-in 40s', withDecade, undefined, walkIn)).toBe('walk-in');
    expect(rebuildWords('box 40s is fine', withDecade, undefined, walkIn)).toBe('box 40s is fine');
  });

  // "one" and "two" name reach-ins only inside their names, and "zero" is a figure wherever it stands.
  it('drops number words a name holds when they stand outside it, and counts zero against the two figures', () => {
    expect(rebuildWords('walk-in one two one one two two one zero', profile, undefined, walkIn)).toBe('walk-in zero');
    expect(rebuildWords('zero zero zero zero', profile, undefined, walkIn)).toBe('zero zero');
    expect(rebuildWords('the reach-in one is fine', profile, undefined, walkIn)).toBe('the reach-in one is fine');
  });

  it('quotes a figure with one decimal place as said', () => {
    expect(rebuildWords('under 38.5', profile, undefined, walkIn)).toBe('under 38.5');
  });

  // Dropping the symbol would quote "<41" as "reads 41", a refused line that reads like a reading.
  it('keeps a limit symbol beside the figure it limits, and drops one that touches no figure', () => {
    expect(rebuildWords('the walk-in reads <41', profile, undefined, walkIn)).toBe('the walk-in reads < 41');
    expect(rebuildWords('the walk-in reads ~38', profile, undefined, walkIn)).toBe('the walk-in reads ~ 38');
    expect(rebuildWords('the walk-in reads 38+', profile, undefined, walkIn)).toBe('the walk-in reads 38 +');
    expect(rebuildWords('the walk-in > the reach-in', profile, undefined, walkIn)).toBe('the walk-in the reach-in');
  });

  it('stores no words for a refused call that names no check and says nothing recognised', () => {
    expect(rebuildWords('<b>hello</b>', profile, undefined, undefined)).toBe('');
  });
});

describe('rebuildWords on a line with a value', () => {
  it('drops the digits and number words of a name when they stand outside it', () => {
    expect(rebuildWords('walk-in 38 1 2 1 2', profile, 38, walkIn)).toBe('walk-in 38');
    expect(rebuildWords('walk-in 38 one two one two', profile, 38, walkIn)).toBe('walk-in 38');
  });

  it('keeps a name whole, digit and all', () => {
    expect(rebuildWords('reach-in 2 reads 38', profile, 38, walkIn)).toBe('reach-in 2 reads 38');
    expect(rebuildWords('the reach-in one reads 38', profile, 38, walkIn)).toBe('the reach-in one reads 38');
  });

  it('keeps at most two figures beside the value', () => {
    expect(rebuildWords('walk-in 38 zero zero zero zero', profile, 38, walkIn)).toBe('walk-in 38 zero zero');
  });

  it('stores the number alone when the words never name it and no check point is known', () => {
    expect(rebuildWords('minus five', profile, -5, undefined)).toBe('-5');
  });
});

describe('names a profile holds', () => {
  function withWalkInAliases(aliases: string[]) {
    return KitchenProfileSchema.parse({
      ...demoJson,
      checkPoints: demoJson.checkPoints.map((point) => (point.id === 'walk_in' ? { ...point, aliases: [...point.aliases, ...aliases] } : point)),
    });
  }

  // An alias of punctuation alone holds no words, and a name of no words would match at every place
  // and never be stepped past.
  it('reads the words around an alias that holds no words', () => {
    const withMark = withWalkInAliases(['!']);
    expect(classifyNumberWords(tokensOf('the walk-in reads 38'), withMark)).toEqual({ kind: 'plain' });
    expect(rebuildWords('the walk-in reads 38', withMark, 38, walkIn)).toBe('the walk-in reads 38');
  });

  // Found first, the shorter name would leave the rest of the longer one outside any name.
  it('takes the longest name said, so the digit of "box 2" stays inside it', () => {
    expect(rebuildWords('box 2 reads 38', withWalkInAliases(['box', 'box 2']), 38, walkIn)).toBe('box 2 reads 38');
  });
});

describe('tokensOf', () => {
  it('leaves no empty token where punctuation opens or closes the words', () => {
    expect(tokensOf('Walk-in: 38!')).toEqual(['walk-in', '38']);
    expect(tokensOf('?!')).toEqual([]);
  });

  it('trims every dot at the end of a token and keeps the decimal point inside it', () => {
    expect(tokensOf('the walk-in reads 38.5...')).toEqual(['the', 'walk-in', 'reads', '38.5']);
  });

  it('trims every dot at the start of a token, so a figure after a pause is still a figure', () => {
    expect(tokensOf('the walk-in reads ...38')).toEqual(['the', 'walk-in', 'reads', '38']);
  });
});

describe('saysCorrection', () => {
  it('finds a correction phrase across a pause written as dots', () => {
    expect(saysCorrection('wrong ... number', profile)).toBe(true);
  });
});

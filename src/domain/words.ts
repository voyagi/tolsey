import type { CheckPoint, KitchenProfile } from './rule';

type Hedges = KitchenProfile['vocabulary']['hedges'];

type Phrases = readonly (readonly string[])[];

// Every check point and food name and alias, as the tokens words are rebuilt from and as the parts
// classifying compares.
interface Names {
  tokens: Phrases;
  parts: Phrases;
}

const recognisedByProfile = new WeakMap<KitchenProfile, ReadonlySet<string>>();
const namesByProfile = new WeakMap<KitchenProfile, Names>();

function hedgeWords(hedges: Hedges): string[] {
  const { limits, below, zero, signs, approximations, decades, tens, ranges, phrases } = hedges;
  return [
    ...limits, below, zero, ...signs, ...approximations, ...decades, ...tens, ...ranges, ...phrases.flatMap(tokensOf),
  ];
}

function namePhrases(profile: KitchenProfile): string[] {
  return [...profile.checkPoints, ...profile.foods].flatMap((named) => [named.name, ...named.aliases]);
}

// A figure inside a name ("reach-in 2", "reach-in one") is no word of its own: it is kept only where
// the name is said, so outside one it is never let through unlimited.
function recognisedTokens(profile: KitchenProfile): ReadonlySet<string> {
  let tokens = recognisedByProfile.get(profile);
  if (!tokens) {
    const { verbs, articles, nouns, states, corrections, hedges } = profile.vocabulary;
    tokens = new Set([
      ...namePhrases(profile).flatMap((phrase) => tokensOf(phrase).filter((token) => !isFigure(token))),
      ...verbs,
      ...articles,
      ...nouns,
      ...states,
      ...corrections.flatMap(tokensOf),
      ...hedgeWords(hedges),
    ]);
    recognisedByProfile.set(profile, tokens);
  }
  return tokens;
}

// Longest first, so "walk-in cooler" is found before "walk-in". An empty phrase could never be stepped
// past, so none is kept.
function longestFirst(phrases: string[][]): Phrases {
  return phrases.filter((phrase) => phrase.length > 0).sort((a, b) => b.length - a.length);
}

function namesOf(profile: KitchenProfile): Names {
  let names = namesByProfile.get(profile);
  if (!names) {
    const tokens = namePhrases(profile).map(tokensOf);
    names = { tokens: longestFirst(tokens), parts: longestFirst(tokens.map((name) => name.flatMap(spokenParts))) };
    namesByProfile.set(profile, names);
  }
  return names;
}

function nameAt(items: readonly string[], at: number, names: Phrases): readonly string[] | undefined {
  return names.find((name) => name.every((item, offset) => items[at + offset] === item));
}

// The parts left once every name said in them is taken out, so neither a state word inside a name
// ("cool" in the cooling check's "cool down") nor a digit inside one ("reach-in 2") is read as what
// the cook said about the check.
function withoutNames(parts: readonly string[], names: Phrases): string[] {
  const left: string[] = [];
  let at = 0;
  while (at < parts.length) {
    const name = nameAt(parts, at, names);
    if (name) {
      at += name.length;
    } else {
      left.push(parts[at]);
      at += 1;
    }
  }
  return left;
}

// Every dash and the minus sign a transcript may carry, read as the hyphen, so "38" en dash "40" is
// the range "38-40" and a minus sign before 5 is "-5".
const DASHES = /[\u2010-\u2015\u2212]/g;

// A limit or a guess a host writes as a symbol ("<41", "~38", "38+"). Each stands as a token of its
// own, so it is read beside the figure it limits instead of vanishing as punctuation.
const HEDGE_SYMBOLS = '<>~+\u2248\u2264\u2265';
const HEDGE_SYMBOL: ReadonlySet<string> = new Set(HEDGE_SYMBOLS);
const HEDGE_SYMBOL_ANYWHERE = new RegExp(`[${HEDGE_SYMBOLS}]`, 'g');
const TOKEN_SEPARATOR = new RegExp(`[^a-z0-9.${HEDGE_SYMBOLS}-]+`);

// An apostrophe joins its word rather than splitting it, so "it's" stays one token.
export function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(DASHES, '-')
    .replace(HEDGE_SYMBOL_ANYWHERE, ' $& ')
    .split(TOKEN_SEPARATOR)
    .map((token) => token.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean);
}

export function formatValue(value: number): string {
  return String(value);
}

// A negative is words that say a reading below zero ("minus 5", "5 below", "minus five"). They give only
// the sign: the figures they name are held to the value's size apart from it (namesAnotherMagnitude). A
// zero said with a sign ("0 below", "minus zero") is a plain zero, since zero takes no sign.
export type NumberWords = { kind: 'plain' } | { kind: 'negative' } | { kind: 'hedge' };

const PLAIN: NumberWords = { kind: 'plain' };
const NEGATIVE: NumberWords = { kind: 'negative' };
const HEDGE: NumberWords = { kind: 'hedge' };

const NUMBER_TOKEN = /^-?\d+(\.\d+)?$/;
// A decade said in digits, at any width: "40s" at a cooler, "130s" around the hot-holding limit.
const DECADE_FIGURE = /^\d+0s$/;
const ISH_FIGURE = /^(\d+(?:\.\d+)?)ish$/;

function isNumber(token: string | undefined): boolean {
  return token !== undefined && NUMBER_TOKEN.test(token);
}

// The words a figure is said in. They give no value here; they only let a range said in words
// ("thirty eight or thirty nine") be told from a reading. A stored line keeps only those the
// vocabulary holds, each counted against the two-figure limit, so a number said word by word can
// never pass it.
const NUMBER_WORDS: ReadonlySet<string> = new Set([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty',
  'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred',
]);

// A figure said either way, in digits or in words. A decade in digits counts too: hedgesAt already
// hedges one on its own, but a name holding one ("box 40s") must keep it only inside the name.
function isFigure(token: string | undefined): boolean {
  return token !== undefined && (isNumber(token) || NUMBER_WORDS.has(token) || DECADE_FIGURE.test(token));
}

// tokensOf keeps a hyphen inside a token, since "walk-in" and "-5" need it, so a hedge written with
// one ("mid-30s", "38-ish", "5-below") would hide inside a single token. For classifying only, a
// hyphenated token is split at its hyphens and each piece read on its own, so "38-40ish" still says
// "40 ish"; a dash between two digit figures is a range wherever it stands ("38-40" reads "38 to
// 40"), while number words joined by one ("thirty-eight") stay one number. "38ish" reads "38 ish",
// and a negative number stays whole.
function spokenParts(token: string): string[] {
  if (NUMBER_TOKEN.test(token)) return [token];
  // A dash standing alone between two figures, "38 - 40", is the same range as "38-40".
  if (/^-+$/.test(token)) return ['to'];
  const ish = ISH_FIGURE.exec(token);
  if (ish) return [ish[1], 'ish'];
  const pieces = token.split('-').filter(Boolean);
  if (pieces.length < 2) return pieces;
  const parts: string[] = [];
  for (const piece of pieces.map(spokenParts)) {
    if (isNumber(parts.at(-1)) && isNumber(piece[0])) parts.push('to');
    parts.push(...piece);
  }
  return parts;
}

// The unit said between a figure and "below", as in "5 degrees below zero".
const UNIT_WORDS: ReadonlySet<string> = new Set(['degree', 'degrees']);

// The figure a sign "below" at index follows, stepping over a unit word, or undefined.
function figureBefore(tokens: readonly string[], index: number): string | undefined {
  const before = UNIT_WORDS.has(tokens[index - 1] ?? '') ? tokens[index - 2] : tokens[index - 1];
  return isNumber(before) ? before : undefined;
}

// "below" is a hedge before a number ("below 5") and a sign after one ("5 below", "5 degrees below
// zero"). It is a sign only when nothing but the zero word follows it: "38 below 41" and "2 below the
// limit" compare a reading with a limit, which is no reading below zero.
function isSignBelow(tokens: readonly string[], index: number, hedges: Hedges): boolean {
  if (tokens[index] !== hedges.below || figureBefore(tokens, index) === undefined) return false;
  const next = tokens[index + 1];
  return next === undefined || next === hedges.zero || next === '0';
}

// A symbol limits a figure only where it touches one: markup brackets around words pass, while a
// bracket touching a figure ("<b>38</b>") cannot be told from a limit and counts as one.
function isSymbolOnFigure(tokens: readonly string[], index: number): boolean {
  return HEDGE_SYMBOL.has(tokens[index]) && (isFigure(tokens[index - 1]) || isFigure(tokens[index + 1]));
}

// Every limit word other than a sign "below" hedges wherever it stands, and a decade word hedges the
// figure after it: "high 40" is somewhere in the high forties, never 40. A symbol on a figure refuses,
// the safe direction.
function hedgesAt(tokens: readonly string[], index: number, hedges: Hedges): boolean {
  const token = tokens[index];
  if (hedges.approximations.includes(token) || hedges.tens.includes(token) || DECADE_FIGURE.test(token)) return true;
  if (HEDGE_SYMBOL.has(token)) return isSymbolOnFigure(tokens, index);
  if (hedges.limits.includes(token)) return !isSignBelow(tokens, index, hedges);
  if (hedges.ranges.includes(token)) return isFigure(tokens[index - 1]) && isFigure(tokens[index + 1]);
  if (hedges.decades.includes(token)) return isFigure(tokens[index + 1]);
  return false;
}

function saysPhrase(tokens: readonly string[], phrases: readonly string[]): boolean {
  const said = ` ${tokens.join(' ')} `;
  return phrases.some((phrase) => said.includes(` ${tokensOf(phrase).join(' ')} `));
}

function saysHedge(tokens: readonly string[], hedges: Hedges): boolean {
  if (saysPhrase(tokens, hedges.phrases)) return true;
  return tokens.some((_, index) => hedgesAt(tokens, index, hedges));
}

// A number or a check sent beside the phrase does not make it a reading (D-05).
export function saysCorrection(words: string | undefined, profile: KitchenProfile): boolean {
  return words !== undefined && saysPhrase(tokensOf(words), profile.vocabulary.corrections);
}

function below(figure: string | undefined): NumberWords | undefined {
  return Number(figure) > 0 ? NEGATIVE : undefined;
}

// A zero in digits after a sign ("minus 0", "-0") is a plain zero when it is the last figure said.
// With a figure after it ("minus 0 point 5") the sign could belong to either, as in "minus, uh, 5".
function signedFigure(tokens: readonly string[], at: number): NumberWords | undefined {
  const figure = tokens[at].replace(/^-/, '');
  return below(figure) ?? (tokens.slice(at + 1).some(isFigure) ? HEDGE : undefined);
}

// "5 below" names its figure before the sign and "minus 5" after it. A sign word with no figure in
// the words at all ("minus five") still says the reading is below zero, of a magnitude the words do
// not give. A sign word apart from the one figure said ("minus, uh, 5") could belong to anything, so
// the words are not a reading. Zero takes no sign, so "minus zero" is a plain zero, as "minus 0" is,
// and with any figure after it ("minus zero point five", "minus zero, five minutes ago") the sign
// could belong to either, so the words are a hedge, as "minus 0 point 5" is.
function signedOf(tokens: readonly string[], hedges: Hedges): NumberWords | undefined {
  const signBelow = tokens.findIndex((_, at) => isSignBelow(tokens, at, hedges));
  if (signBelow >= 0) return below(figureBefore(tokens, signBelow));
  // A figure written with its own minus, "-5", names its magnitude the way "minus 5" does.
  const minusFigure = tokens.findIndex((token) => isNumber(token) && token.startsWith('-'));
  if (minusFigure >= 0) return signedFigure(tokens, minusFigure);
  const sign = tokens.findIndex((token) => hedges.signs.includes(token));
  if (sign < 0) return undefined;
  const figure = tokens[sign + 1];
  if (isNumber(figure)) return signedFigure(tokens, sign + 1);
  if (tokens.some(isNumber)) return HEDGE;
  if (figure === hedges.zero) return tokens.slice(sign + 2).some(isFigure) ? HEDGE : undefined;
  return NEGATIVE;
}

// Names are taken out first, so only what the cook said about the check is judged.
function partsOf(tokens: readonly string[], profile: KitchenProfile): string[] {
  return withoutNames(tokens.flatMap(spokenParts), namesOf(profile).parts);
}

// The wall reads the figure from these same parts, so the page and the server take names out by one
// rule: a second alias matcher in the page would drift from this one.
export function partsWithoutNames(tokens: readonly string[], profile: KitchenProfile): string[] {
  return partsOf(tokens, profile);
}

function hedgeOrSign(parts: readonly string[], hedges: Hedges): NumberWords | undefined {
  return saysHedge(parts, hedges) ? HEDGE : signedOf(parts, hedges);
}

// Number words are not parsed into values here (that grammar is the intent layer's); this only says
// whether the words give a reading, a reading below zero, or something other than a reading. A state
// word counts only when no number was said at all: "fine at 38" still names its number.
export function classifyNumberWords(tokens: readonly string[], profile: KitchenProfile): NumberWords {
  const { hedges, states } = profile.vocabulary;
  const parts = partsOf(tokens, profile);
  const said = hedgeOrSign(parts, hedges);
  if (said !== undefined) return said;
  if (parts.some(isNumber)) return PLAIN;
  return parts.some((token) => states.includes(token)) ? HEDGE : PLAIN;
}

// The words of an answer to which check or who is logging, whose number was said and held before.
// Only a hedge or a sign in them says something about that number. Anything else, a state word
// included ("MR, it's fine"), answers the question and leaves the number as it was.
export function answerNumberWords(tokens: readonly string[], profile: KitchenProfile): NumberWords {
  return hedgeOrSign(partsOf(tokens, profile), profile.vocabulary.hedges) ?? PLAIN;
}

// Whether the cook said a figure at all, in digits or in words, once names are taken out: plain words
// that give one also give its sign, so only words with no figure leave the value's sign to the host.
export function namesAFigure(tokens: readonly string[], profile: KitchenProfile): boolean {
  return partsOf(tokens, profile).some(isFigure);
}

const SINGLE_DIGIT = /^\d$/;

// Single digits said one at a time ("1 5", as the digit repeat asks for) spell one number, so a run of
// them is joined before figures are read. A longer figure never joins a run ("38 5" stays two). The wall
// joins an answer's digits by this same rule, so the page and the server agree on what "1 5" says.
export function joinDigits(parts: readonly string[]): string[] {
  const joined: string[] = [];
  let inRun = false;
  for (const part of parts) {
    const digit = SINGLE_DIGIT.test(part);
    if (digit && inRun) joined[joined.length - 1] += part;
    else joined.push(part);
    inRun = digit;
  }
  return joined;
}

// A figure as the digits it is written in, where the words alone give one: digits, or the zero word.
// Every other number word needs the intent layer's grammar ("thirty eight"), so none is read here.
function figureDigits(part: string, hedges: Hedges): string | undefined {
  if (isNumber(part)) return part;
  return part === hedges.zero ? '0' : undefined;
}

const DIGIT_RUN = /^\d+$/;
const POINT = 'point';
// The one fraction read in words. Any other ("38 and a quarter") is the intent layer's to read, so the
// whole figure before it is compared as said.
const AND_A_HALF: readonly string[] = ['and', 'a', 'half'];
// The digits after a point said one word at a time ("point five"), and the digit words the wall reads in
// an answer to a question ("one five").
export const DIGIT_OF_WORD: ReadonlyMap<string, string> = new Map(
  ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'].map((word, digit) => [word, String(digit)]),
);

// Past the last part the lookup finds nothing, which ends the run.
function digitWordsAt(parts: readonly string[], at: number): string {
  let digits = '';
  let digit = DIGIT_OF_WORD.get(parts[at]);
  while (digit !== undefined) {
    digits += digit;
    digit = DIGIT_OF_WORD.get(parts[at + digits.length]);
  }
  return digits;
}

interface Fraction {
  // The digits after the point, or undefined for a point no digits follow ("38 point fifty").
  digits: string | undefined;
  length: number;
}

// The fraction said at `at`, right after a whole figure: "and a half", or "point" and its digits, said
// as one run ("point 5", and "point 2 5" once single digits are joined) or as digit words ("point five").
function fractionAt(parts: readonly string[], at: number): Fraction | undefined {
  if (AND_A_HALF.every((word, offset) => parts[at + offset] === word)) return { digits: '5', length: AND_A_HALF.length };
  if (parts[at] !== POINT) return undefined;
  // A point at the very end tests the text "undefined", which is no run of digits.
  const run = parts[at + 1];
  if (DIGIT_RUN.test(run)) return { digits: run, length: 2 };
  const words = digitWordsAt(parts, at + 1);
  return { digits: words === '' ? undefined : words, length: 1 + words.length };
}

interface FigureAt {
  figure: number | undefined;
  length: number;
}

// The figure at `at` with a fraction said after it read in, so "38 point 5" and "38 and a half" are both
// 38.5. A fraction that cannot be read gives NaN, which equals no value: a point no digits follow, or a
// fraction said after a figure that has one already ("38.5 and a half").
function figureAt(parts: readonly string[], at: number, hedges: Hedges): FigureAt {
  const digits = figureDigits(parts[at], hedges);
  if (digits === undefined) return { figure: undefined, length: 1 };
  const fraction = fractionAt(parts, at + 1);
  if (fraction === undefined) return { figure: Number(digits), length: 1 };
  const figure = fraction.digits === undefined ? Number.NaN : Number(`${digits}.${fraction.digits}`);
  return { figure, length: 1 + fraction.length };
}

// Every figure in the parts, single digits said one at a time joined first, so "3 8 point 5" is 38.5.
function figuresSaid(parts: readonly string[], hedges: Hedges): number[] {
  const joined = joinDigits(parts);
  const figures: number[] = [];
  let at = 0;
  while (at < joined.length) {
    const { figure, length } = figureAt(joined, at, hedges);
    if (figure !== undefined) figures.push(figure);
    at += length;
  }
  return figures;
}

// Whether the words name a figure the value is not, once names are taken out, so a value sent beside
// another number ("walk-in 38" with 39) is never logged as what the cook said. Every figure counts, since
// two figures are two readings or a reading and a time, and each is compared whole: "41 degrees" is not
// 41.9, and "38 and a half" is 38.5, never 38.9 or 38.
export function namesAnotherFigure(tokens: readonly string[], profile: KitchenProfile, value: number): boolean {
  return figuresSaid(partsOf(tokens, profile), profile.vocabulary.hedges).some((figure) => figure !== value);
}

// The same for words that say a reading below zero, whose sign stands apart from the figure ("minus 5",
// "-5", "5 below"): each figure is held to the value's size, so "minus 5 and 7" is no -5. The zero a sign
// "below" ends on ("5 degrees below zero") is part of the sign, never a figure.
export function namesAnotherMagnitude(tokens: readonly string[], profile: KitchenProfile, magnitude: number): boolean {
  const { hedges } = profile.vocabulary;
  const parts = partsOf(tokens, profile).filter((_, at, all) => !isSignBelow(all, at - 1, hedges));
  return figuresSaid(parts, hedges).some((figure) => Math.abs(figure) !== magnitude);
}

interface Named {
  kind: 'checkPoint' | 'food';
  id: string;
  tokens: readonly string[];
}

interface Nameable {
  id: string;
  name: string;
  aliases: readonly string[];
}

const namedByProfile = new WeakMap<KitchenProfile, readonly Named[]>();

function namedAs(kind: Named['kind'], items: readonly Nameable[]): Named[] {
  return items.flatMap((item) => [item.name, ...item.aliases].map((phrase) => ({ kind, id: item.id, tokens: tokensOf(phrase) })));
}

// Every check point and food name and alias with the id it names, longest first like namesOf.
function namedOf(profile: KitchenProfile): readonly Named[] {
  let named = namedByProfile.get(profile);
  if (!named) {
    named = [...namedAs('checkPoint', profile.checkPoints), ...namedAs('food', profile.foods)]
      .filter((name) => name.tokens.length > 0)
      .sort((a, b) => b.tokens.length - a.tokens.length);
    namedByProfile.set(profile, named);
  }
  return named;
}

// The measured id the contract gives a unit's air, said as the word itself.
const AIR = 'air';

export interface NamedInWords {
  checkPoints: ReadonlySet<string>;
  // What the reading was taken of: the foods named, and the air when the word is said outside a name.
  measured: ReadonlySet<string>;
}

// The check points and the measured the words name, each name found longest first, so "walk-in freezer"
// names the freezer and "soup well" the check point, never the walk-in or the soup.
export function namedInWords(tokens: readonly string[], profile: KitchenProfile): NamedInWords {
  const named = namedOf(profile);
  const checkPoints = new Set<string>();
  const measured = new Set<string>();
  let at = 0;
  while (at < tokens.length) {
    const name = named.find((candidate) => candidate.tokens.every((item, offset) => tokens[at + offset] === item));
    if (name) (name.kind === 'checkPoint' ? checkPoints : measured).add(name.id);
    else if (tokens[at] === AIR) measured.add(AIR);
    at += name ? name.tokens.length : 1;
  }
  return { checkPoints, measured };
}

// A figure a thermometer could show, kept in a refused line so it quotes "under 41" or "38 or 39" as
// said. Two are the most a limit or a range needs, so a third figure, and any longer run of digits,
// never persists: digits said in groups, such as a phone or card number, are never stored whole.
const READING_FIGURE = /^-?\d{1,3}(\.\d)?$/;
const MOST_FIGURES_QUOTED = 2;

// A figure quoted as said: on a refused line any short run of digits, and on either line a recognised
// number word such as "zero". Number words the vocabulary does not hold are never kept at all.
function isQuotedFigure(token: string, known: ReadonlySet<string>, quotesDigits: boolean): boolean {
  return (quotesDigits && READING_FIGURE.test(token)) || (NUMBER_WORDS.has(token) && known.has(token));
}

// A name is kept whole, digit and all ("reach-in 2"); every other figure counts against the two, even
// one a name also holds, so a run of ones and twos is never stored whole either. The value, when there
// is one, is kept as stored and counts against nothing: it is the reading.
function storedTokens(tokens: readonly string[], profile: KitchenProfile, value: number | undefined): string[] {
  const known = recognisedTokens(profile);
  const names = namesOf(profile).tokens;
  const number = value === undefined ? undefined : formatValue(value);
  const kept: string[] = [];
  let figures = 0;
  let at = 0;
  while (at < tokens.length) {
    const name = nameAt(tokens, at, names);
    const token = tokens[at];
    if (name) {
      kept.push(...name);
    } else if (number !== undefined && Number(token) === value) {
      kept.push(number);
    } else if (isQuotedFigure(token, known, number === undefined)) {
      if (figures < MOST_FIGURES_QUOTED) kept.push(token);
      figures += 1;
    } else if (number === undefined && isSymbolOnFigure(tokens, at)) {
      // The limit stays with the figure it limits, so "<41" is quoted "< 41", never a plain 41.
      kept.push(token);
    } else if (known.has(token)) {
      kept.push(token);
    }
    at += name ? name.length : 1;
  }
  return kept;
}

// Only recognised tokens and the number itself persist, so no visitor free text or markup reaches
// the record (BUILD-SPEC A7). A token naming the value in another spelling ("38.0") is written the
// way the value is stored. Words that never name the value ("minus five", "38 and a half") are
// replaced by the check point and the number, so a stored line never reads as a reading without one.
// With no value, as on a refused line, the recognised words are quoted as said.
export function rebuildWords(
  raw: string | undefined,
  profile: KitchenProfile,
  value: number | undefined,
  checkPoint: CheckPoint | undefined,
): string {
  const kept = storedTokens(raw === undefined ? [] : tokensOf(raw), profile, value);
  const checkPointName = checkPoint?.name.toLowerCase();
  if (value === undefined) return kept.length > 0 ? kept.join(' ') : (checkPointName ?? '');
  const number = formatValue(value);
  if (kept.includes(number)) return kept.join(' ');
  return checkPointName === undefined ? number : `${checkPointName} ${number}`;
}

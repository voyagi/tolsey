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

function recognisedTokens(profile: KitchenProfile): ReadonlySet<string> {
  let tokens = recognisedByProfile.get(profile);
  if (!tokens) {
    const { verbs, articles, nouns, states, corrections, hedges } = profile.vocabulary;
    tokens = new Set([
      ...namePhrases(profile).flatMap((phrase) => [phrase.toLowerCase(), ...tokensOf(phrase)]),
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

// An apostrophe joins its word rather than splitting it, so "it's" stays one token.
export function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(DASHES, '-')
    .split(/[^a-z0-9.-]+/)
    .map((token) => token.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean);
}

export function formatValue(value: number): string {
  return String(value);
}

// A negative carries the magnitude its words name, or none when the number after the sign was said in
// words ("minus five"): the value then gives the magnitude and the words only its sign.
export type NumberWords = { kind: 'plain' } | { kind: 'negative'; magnitude: number | undefined } | { kind: 'hedge' };

const PLAIN: NumberWords = { kind: 'plain' };
const HEDGE: NumberWords = { kind: 'hedge' };

const NUMBER_TOKEN = /^-?\d+(\.\d+)?$/;
const DECADE_FIGURE = /^\d0s$/;
const RANGE_FIGURE = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/;
const ISH_FIGURE = /^(\d+(?:\.\d+)?)ish$/;

function isNumber(token: string | undefined): boolean {
  return token !== undefined && NUMBER_TOKEN.test(token);
}

// The words a figure is said in. They give no value here; they only let a range said in words
// ("thirty eight or thirty nine") be told from a reading. They are never kept in a stored line, so a
// number said word by word can never pass the refused line's two-figure limit.
const NUMBER_WORDS: ReadonlySet<string> = new Set([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty',
  'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred',
]);

// A figure said either way, in digits or in words.
function isFigure(token: string | undefined): boolean {
  return isNumber(token) || (token !== undefined && NUMBER_WORDS.has(token));
}

// tokensOf keeps a hyphen inside a token, since "walk-in" and "-5" need it, so a hedge written with
// one ("mid-30s", "38-ish", "5-below") would hide inside a single token. For classifying only, a
// digit range "38-40" reads as "38 to 40", "38ish" as "38 ish", and any other hyphenated token is
// split at its hyphens; a negative number stays whole.
function spokenParts(token: string): string[] {
  if (NUMBER_TOKEN.test(token)) return [token];
  // A dash standing alone between two figures, "38 - 40", is the same range as "38-40".
  if (/^-+$/.test(token)) return ['to'];
  const range = RANGE_FIGURE.exec(token);
  if (range) return [range[1], 'to', range[2]];
  const ish = ISH_FIGURE.exec(token);
  if (ish) return [ish[1], 'ish'];
  return token.split('-').filter(Boolean);
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

// Every limit word other than a sign "below" hedges wherever it stands, and a decade word hedges the
// figure after it: "high 40" is somewhere in the high forties, never 40.
function hedgesAt(tokens: readonly string[], index: number, hedges: Hedges): boolean {
  const token = tokens[index];
  if (hedges.approximations.includes(token) || hedges.tens.includes(token) || DECADE_FIGURE.test(token)) return true;
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
  const magnitude = Number(figure);
  return magnitude > 0 ? { kind: 'negative', magnitude } : undefined;
}

// "5 below" names its figure before the sign and "minus 5" after it. A sign word with no figure in
// the words at all ("minus five") still says the reading is below zero, of a magnitude the words do
// not give. A sign word apart from the one figure said ("minus, uh, 5") could belong to anything, so
// the words are not a reading.
function signedOf(tokens: readonly string[], hedges: Hedges): NumberWords | undefined {
  const signBelow = tokens.findIndex((_, at) => isSignBelow(tokens, at, hedges));
  if (signBelow >= 0) return below(figureBefore(tokens, signBelow));
  // A figure written with its own minus, "-5", names its magnitude the way "minus 5" does.
  const minusFigure = tokens.find((token) => isNumber(token) && token.startsWith('-'));
  if (minusFigure !== undefined) return below(minusFigure.slice(1));
  const sign = tokens.findIndex((token) => hedges.signs.includes(token));
  if (sign < 0) return undefined;
  const figure = tokens[sign + 1];
  if (isNumber(figure)) return below(figure);
  return tokens.some(isNumber) ? HEDGE : { kind: 'negative', magnitude: undefined };
}

// Names are taken out first, so only what the cook said about the check is judged.
function partsOf(tokens: readonly string[], profile: KitchenProfile): string[] {
  return withoutNames(tokens.flatMap(spokenParts), namesOf(profile).parts);
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

// A figure a thermometer could show, kept in a refused line so it quotes "under 41" or "38 or 39" as
// said. Two are the most a limit or a range needs, so a third figure, and any longer run of digits,
// never persists: digits said in groups, such as a phone or card number, are never stored whole.
const READING_FIGURE = /^-?\d{1,3}(\.\d)?$/;
const MOST_FIGURES_QUOTED = 2;

// A name is kept whole, digit and all ("reach-in 2"); every other figure counts against the two, even
// one a name also holds, so a run of ones and twos is never stored whole either.
function refusedWords(tokens: string[], profile: KitchenProfile, checkPoint: CheckPoint | undefined): string {
  const known = recognisedTokens(profile);
  const names = namesOf(profile).tokens;
  const kept: string[] = [];
  let figures = 0;
  let at = 0;
  while (at < tokens.length) {
    const name = nameAt(tokens, at, names);
    const token = tokens[at];
    if (name) {
      kept.push(...name);
    } else if (READING_FIGURE.test(token)) {
      if (figures < MOST_FIGURES_QUOTED) kept.push(token);
      figures += 1;
    } else if (known.has(token)) {
      kept.push(token);
    }
    at += name ? name.length : 1;
  }
  if (kept.length > 0) return kept.join(' ');
  return checkPoint === undefined ? '' : checkPoint.name.toLowerCase();
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
  const tokens = raw === undefined ? [] : tokensOf(raw);
  if (value === undefined) return refusedWords(tokens, profile, checkPoint);
  const known = recognisedTokens(profile);
  const number = formatValue(value);
  const kept = tokens
    .map((token) => (Number(token) === value ? number : token))
    .filter((token) => token === number || known.has(token));
  if (kept.includes(number)) return kept.join(' ');
  return checkPoint === undefined ? number : `${checkPoint.name.toLowerCase()} ${number}`;
}

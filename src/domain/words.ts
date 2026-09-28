import type { CheckPoint, KitchenProfile } from './rule';

type Vocabulary = KitchenProfile['vocabulary'];
type Hedges = Vocabulary['hedges'];

const recognisedByProfile = new WeakMap<KitchenProfile, ReadonlySet<string>>();

function hedgeWords(hedges: Hedges): string[] {
  const { limits, below, zero, approximations, decades, tens, ranges, phrases } = hedges;
  return [...limits, below, zero, ...approximations, ...decades, ...tens, ...ranges, ...phrases.flatMap(tokensOf)];
}

function recognisedTokens(profile: KitchenProfile): ReadonlySet<string> {
  let tokens = recognisedByProfile.get(profile);
  if (!tokens) {
    const phrases = [...profile.checkPoints, ...profile.foods].flatMap((named) => [named.name, ...named.aliases]);
    const { verbs, articles, nouns, states, hedges } = profile.vocabulary;
    tokens = new Set([
      ...phrases.flatMap((phrase) => [phrase.toLowerCase(), ...tokensOf(phrase)]),
      ...verbs,
      ...articles,
      ...nouns,
      ...states,
      ...hedgeWords(hedges),
    ]);
    recognisedByProfile.set(profile, tokens);
  }
  return tokens;
}

// An apostrophe joins its word rather than splitting it, so "it's" stays one token.
export function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9.-]+/)
    .map((token) => token.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean);
}

export function formatValue(value: number): string {
  return String(value);
}

export type NumberWords = { kind: 'plain' } | { kind: 'negative'; value: number } | { kind: 'hedge' };

const PLAIN: NumberWords = { kind: 'plain' };
const HEDGE: NumberWords = { kind: 'hedge' };

const NUMBER_TOKEN = /^-?\d+(\.\d+)?$/;
const DECADE_FIGURE = /^\d0s$/;

function isNumber(token: string | undefined): boolean {
  return token !== undefined && NUMBER_TOKEN.test(token);
}

// "below" is a hedge before a number ("below 5") and a sign after one ("5 below"), so it is judged
// by what precedes it; every other limit word hedges wherever it stands.
function hedgesAt(tokens: readonly string[], index: number, hedges: Hedges): boolean {
  const token = tokens[index];
  if (hedges.approximations.includes(token) || hedges.tens.includes(token) || DECADE_FIGURE.test(token)) return true;
  if (hedges.limits.includes(token)) return !(token === hedges.below && isNumber(tokens[index - 1]));
  if (hedges.ranges.includes(token)) return isNumber(tokens[index - 1]) && isNumber(tokens[index + 1]);
  return false;
}

function saysHedge(tokens: readonly string[], hedges: Hedges): boolean {
  const said = ` ${tokens.join(' ')} `;
  if (hedges.phrases.some((phrase) => said.includes(` ${tokensOf(phrase).join(' ')} `))) return true;
  return tokens.some((_, index) => hedgesAt(tokens, index, hedges));
}

function negativeOf(tokens: readonly string[], hedges: Hedges): number | undefined {
  const index = tokens.findIndex((token, at) => token === hedges.below && isNumber(tokens[at - 1]));
  if (index < 0) return undefined;
  const magnitude = Number(tokens[index - 1]);
  return magnitude > 0 ? -magnitude : undefined;
}

// Number words are not parsed into values here (that grammar is the intent layer's); this only says
// whether the words give a reading, a reading below zero, or something other than a reading. A state
// word counts only when no number was said at all: "fine at 38" still names its number.
export function classifyNumberWords(tokens: readonly string[], vocabulary: Vocabulary): NumberWords {
  if (saysHedge(tokens, vocabulary.hedges)) return HEDGE;
  const negative = negativeOf(tokens, vocabulary.hedges);
  if (negative !== undefined) return { kind: 'negative', value: negative };
  if (!tokens.some(isNumber) && tokens.some((token) => vocabulary.states.includes(token))) return HEDGE;
  return PLAIN;
}

// A figure a thermometer could show, kept in a refused line so it quotes "under 41" as said; a
// longer run of digits is not a reading and never persists.
const READING_FIGURE = /^-?\d{1,4}(\.\d)?$/;

function refusedWords(tokens: string[], known: ReadonlySet<string>, checkPoint: CheckPoint | undefined): string {
  const kept = tokens.filter((token) => known.has(token) || READING_FIGURE.test(token));
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
  const known = recognisedTokens(profile);
  const tokens = raw === undefined ? [] : tokensOf(raw);
  if (value === undefined) return refusedWords(tokens, known, checkPoint);
  const number = formatValue(value);
  const kept = tokens
    .map((token) => (Number(token) === value ? number : token))
    .filter((token) => token === number || known.has(token));
  if (kept.includes(number)) return kept.join(' ');
  return checkPoint === undefined ? number : `${checkPoint.name.toLowerCase()} ${number}`;
}

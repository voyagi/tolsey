import type { CheckPoint, KitchenProfile } from './rule';

type Hedges = KitchenProfile['vocabulary']['hedges'];

const recognisedByProfile = new WeakMap<KitchenProfile, ReadonlySet<string>>();
const namesByProfile = new WeakMap<KitchenProfile, readonly (readonly string[])[]>();

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
    const { verbs, articles, nouns, states, hedges } = profile.vocabulary;
    tokens = new Set([
      ...namePhrases(profile).flatMap((phrase) => [phrase.toLowerCase(), ...tokensOf(phrase)]),
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

// Every check point and food name and alias in the parts classifying compares, longest first so
// "walk-in cooler" is found before "walk-in". An empty phrase could never be stepped past, so none is kept.
function nameParts(profile: KitchenProfile): readonly (readonly string[])[] {
  let names = namesByProfile.get(profile);
  if (!names) {
    names = namePhrases(profile)
      .map((phrase) => tokensOf(phrase).flatMap(spokenParts))
      .filter((parts) => parts.length > 0)
      .sort((a, b) => b.length - a.length);
    namesByProfile.set(profile, names);
  }
  return names;
}

function startsAt(parts: readonly string[], at: number, name: readonly string[]): boolean {
  return name.every((part, offset) => parts[at + offset] === part);
}

// The parts left once every name said in them is taken out, so a state word inside a name ("cool" in
// the cooling check's "cool down") is never read as the cook's verdict on the check.
function withoutNames(parts: readonly string[], names: readonly (readonly string[])[]): string[] {
  const left: string[] = [];
  let at = 0;
  while (at < parts.length) {
    const name = names.find((candidate) => startsAt(parts, at, candidate));
    if (name) {
      at += name.length;
    } else {
      left.push(parts[at]);
      at += 1;
    }
  }
  return left;
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

// tokensOf keeps a hyphen inside a token, since "walk-in" and "-5" need it, so a hedge written with
// one ("mid-30s", "38-ish", "5-below") would hide inside a single token. For classifying only, a
// digit range "38-40" reads as "38 to 40", "38ish" as "38 ish", and any other hyphenated token is
// split at its hyphens; a negative number stays whole.
function spokenParts(token: string): string[] {
  if (NUMBER_TOKEN.test(token)) return [token];
  const range = RANGE_FIGURE.exec(token);
  if (range) return [range[1], 'to', range[2]];
  const ish = ISH_FIGURE.exec(token);
  if (ish) return [ish[1], 'ish'];
  return token.split('-').filter(Boolean);
}

// "below" is a hedge before a number ("below 5") and a sign after one ("5 below", "5 below zero"). It
// is a sign only when nothing but the zero word follows it: "38 below 41" and "2 below the limit"
// compare a reading with a limit, which is no reading below zero.
function isSignBelow(tokens: readonly string[], index: number, hedges: Hedges): boolean {
  if (tokens[index] !== hedges.below || !isNumber(tokens[index - 1])) return false;
  const next = tokens[index + 1];
  return next === undefined || next === hedges.zero || next === '0';
}

// Every limit word other than a sign "below" hedges wherever it stands.
function hedgesAt(tokens: readonly string[], index: number, hedges: Hedges): boolean {
  const token = tokens[index];
  if (hedges.approximations.includes(token) || hedges.tens.includes(token) || DECADE_FIGURE.test(token)) return true;
  if (hedges.limits.includes(token)) return !isSignBelow(tokens, index, hedges);
  if (hedges.ranges.includes(token)) return isNumber(tokens[index - 1]) && isNumber(tokens[index + 1]);
  return false;
}

function saysHedge(tokens: readonly string[], hedges: Hedges): boolean {
  const said = ` ${tokens.join(' ')} `;
  if (hedges.phrases.some((phrase) => said.includes(` ${tokensOf(phrase).join(' ')} `))) return true;
  return tokens.some((_, index) => hedgesAt(tokens, index, hedges));
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
  if (signBelow >= 0) return below(tokens[signBelow - 1]);
  const sign = tokens.findIndex((token) => hedges.signs.includes(token));
  if (sign < 0) return undefined;
  const figure = tokens[sign + 1];
  if (isNumber(figure)) return below(figure);
  return tokens.some(isNumber) ? HEDGE : { kind: 'negative', magnitude: undefined };
}

// Number words are not parsed into values here (that grammar is the intent layer's); this only says
// whether the words give a reading, a reading below zero, or something other than a reading. A state
// word counts only when no number was said at all ("fine at 38" still names its number), and only
// outside a check point or food name.
export function classifyNumberWords(tokens: readonly string[], profile: KitchenProfile): NumberWords {
  const { hedges, states } = profile.vocabulary;
  const parts = tokens.flatMap(spokenParts);
  if (saysHedge(parts, hedges)) return HEDGE;
  const signed = signedOf(parts, hedges);
  if (signed !== undefined) return signed;
  if (parts.some(isNumber)) return PLAIN;
  return withoutNames(parts, nameParts(profile)).some((token) => states.includes(token)) ? HEDGE : PLAIN;
}

// A figure a thermometer could show, kept in a refused line so it quotes "under 41" or "38 or 39" as
// said. Two are the most a limit or a range needs, so a third figure, and any longer run of digits,
// never persists: digits said in groups, such as a phone or card number, are never stored whole.
const READING_FIGURE = /^-?\d{1,3}(\.\d)?$/;
const MOST_FIGURES_QUOTED = 2;

function refusedWords(tokens: string[], known: ReadonlySet<string>, checkPoint: CheckPoint | undefined): string {
  const kept: string[] = [];
  let figures = 0;
  for (const token of tokens) {
    if (known.has(token)) {
      kept.push(token);
    } else if (READING_FIGURE.test(token) && figures < MOST_FIGURES_QUOTED) {
      kept.push(token);
      figures += 1;
    }
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

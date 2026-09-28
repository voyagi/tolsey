import type { CheckPoint, KitchenProfile } from './rule';

const recognisedByProfile = new WeakMap<KitchenProfile, ReadonlySet<string>>();

function recognisedTokens(profile: KitchenProfile): ReadonlySet<string> {
  let tokens = recognisedByProfile.get(profile);
  if (!tokens) {
    const phrases = [...profile.checkPoints, ...profile.foods].flatMap((named) => [named.name, ...named.aliases]);
    const { verbs, articles, nouns, states } = profile.vocabulary;
    tokens = new Set([
      ...phrases.flatMap((phrase) => [phrase.toLowerCase(), ...tokensOf(phrase)]),
      ...verbs,
      ...articles,
      ...nouns,
      ...states,
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

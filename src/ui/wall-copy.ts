// Every phrase the wall teaches lives here, so the phrase table can prove each one parses to the call
// it is meant to make: a phrase typed into a component could teach words no alias matches.
export const EXAMPLE_PHRASE = 'the walk-in reads 38';

// One phrase per verdict a stranger should see in a few taps: in range, out of range, a check with no
// number, a hedged number, and a number whose misheard twin would change the verdict.
export const CHIPS: readonly string[] = [
  EXAMPLE_PHRASE,
  'the soup well reads 120',
  'reach-in two is fine',
  'the walk-in is under 41',
  'walk-in 15',
];

export const HINT = `Type what the cook says, like ${EXAMPLE_PHRASE}, or tap a phrase.`;

export const LOCAL_REPLY = `Say a check and its number, like: ${EXAMPLE_PHRASE}.`;

export const TAUGHT_PHRASES: readonly string[] = [...new Set([...CHIPS, EXAMPLE_PHRASE])];

// One constant, so the owner's choice of "Tolsey" or "Alexa" is a one-line change. On a real Echo Show
// the cook talks to Alexa, and Alexa answers using Tolsey.
export const SPEAKER_LABEL = 'Alexa';

// The page is a stand-in for the device, and says so on its frame.
export const DEVICE_LABEL = 'simulated Alexa+';

export const KEPT_IN_BROWSER = 'Kept in this browser';

// What the demo is not, said on the page beside it. Every line is a fact about what runs today, never
// a promise: a cut feature is named only under the What's next heading.
export const LIMITS_HEADING = 'Limits';

export const LIMITS: readonly string[] = [
  'This is a simulated Alexa+ screen in a browser, not a real device.',
  "The cook's words are typed or picked here. Speech recognition in a loud kitchen is not tested.",
  'There are no sensors. A cook reads the thermometer and says the number.',
  'Readings are in °F, and a number said with no unit is taken as °F.',
  'The rules are the FDA Food Code 2022 defaults, plus house rules named as such on the pass.',
  '/mcp needs no sign-in, so every write lands in a scratch kitchen that expires within 24 hours.',
];

export const WHATS_NEXT_HEADING = "What's next, not built yet";

export const WHATS_NEXT: readonly string[] = [
  'Corrective actions with a clock',
  'The full schedule',
  'MCP Apps cards',
  'Voice sign-in',
  'The full number grammar',
  'The printable day sheet',
  'The replay',
];

export const PRIVACY_LINK_TEXT = 'Privacy';

export const NOT_LOGGED = 'NOT LOGGED';

export const OPEN_CHECKS_HEADING = 'Open checks';

export const NO_CHECKS_OPEN = 'No checks are open.';

export const OPEN_TILE = 'Open';

// What every open check has in common: its newest line of the day is a refusal, a held reading or a
// "wrong number", and each of them is waiting for a number.
export const NEEDS_A_NUMBER = 'Needs a number';

export const NEW_KITCHEN_SENTENCE = 'That kitchen has closed, so the reading was not logged. A new kitchen is ready: send the words again.';

export const STOPPED_MESSAGE = 'The wall cannot reach its kitchen right now. Reload the page later to start again.';

export const DEMO_FULL_MESSAGE = 'The demo is full for today. Try again tomorrow.';

export const NO_ANSWER_REASON = 'Tolsey did not answer in time. Send the same words again to retry.';

export const UNREACHED_REASON = 'The words never reached Tolsey. Send them again to retry.';

// The status alone, never the body: a body can carry a stack or the cook's own words back.
export function failedAnswerReason(status: number | undefined): string {
  const shown = status === undefined ? '' : ` (status ${status})`;
  return status !== undefined && status >= 400
    ? `Tolsey answered with an error${shown}. Send the same words again to retry.`
    : `Tolsey's answer could not be read${shown}. Send the same words again to retry.`;
}

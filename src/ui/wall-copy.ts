// Every phrase the wall teaches lives here, so the phrase table can prove each one parses to the call
// it is meant to make: a phrase typed into a component could teach words no alias matches.
export const EXAMPLE_PHRASE = 'the walk-in reads 38';

export const CHIPS: readonly string[] = [EXAMPLE_PHRASE, 'reach-in two is fine', 'the walk-in is under 41', 'walk-in 15'];

export const HINT = `Type what the cook says, like ${EXAMPLE_PHRASE}, or tap a phrase.`;

export const LOCAL_REPLY = `Say a check and its number, like: ${EXAMPLE_PHRASE}.`;

export const TAUGHT_PHRASES: readonly string[] = [...new Set([...CHIPS, EXAMPLE_PHRASE])];

// One constant, so the owner's choice of "Tolsey" or "Alexa" is a one-line change.
export const SPEAKER_LABEL = 'Tolsey';

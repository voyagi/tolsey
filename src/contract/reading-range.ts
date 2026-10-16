// Absolute zero, rounded up to the tenth, and a figure past any kitchen probe. The contract refuses a
// value outside them, and the decision refuses a value its words would carry outside them ("minus
// 500"), so both read the bounds from here. The upper bound also keeps the one-decimal check
// meaningful: far above it a number carries no tenths at all, so any huge value would pass as "one
// decimal place".
export const LOWEST_READING_F = -459.6;
export const HIGHEST_READING_F = 1000;

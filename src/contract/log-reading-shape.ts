// The parts of the log_reading result contract that hold without zod or the kitchen file, so the page
// can check an answer against them: log-reading.ts builds its schema and its per-outcome check from
// these same values, and the page bundle stays free of both.

/** @public The version every log_reading result carries, which the page checks before it shows an answer. */
export const CONTRACT_VERSION = 1;

export const OUTCOMES = ['in_range', 'out_of_range', 'refused', 'held', 'not_covered', 'nothing_to_fix'] as const;
export type Outcome = (typeof OUTCOMES)[number];

type OutcomeField ='lineId' | 'recordCode' | 'checkPoint' | 'value' | 'unit' | 'initials' | 'rule' | 'prompt' | 'supersedesLineId';

interface OutcomeFields {
  requires: readonly OutcomeField[];
  forbids: readonly OutcomeField[];
}

const LINE_FIELDS: readonly OutcomeField[] = ['lineId', 'recordCode', 'checkPoint', 'value', 'unit', 'initials'];

// Refusing additional properties says nothing about which fields an outcome must carry, and the SDK
// validates structuredContent only against the schema, so each outcome's shape is held here.
export const OUTCOME_FIELDS: Record<Outcome, OutcomeFields> = {
  in_range: { requires: [...LINE_FIELDS, 'rule'], forbids: ['prompt'] },
  out_of_range: { requires: [...LINE_FIELDS, 'rule'], forbids: ['prompt'] },
  not_covered: { requires: LINE_FIELDS, forbids: ['rule', 'prompt'] },
  refused: { requires: [], forbids: ['value', 'unit', 'rule', 'supersedesLineId'] },
  held: { requires: ['prompt'], forbids: ['lineId', 'recordCode', 'rule', 'supersedesLineId'] },
  nothing_to_fix: {
    requires: [],
    forbids: ['lineId', 'recordCode', 'value', 'unit', 'rule', 'prompt', 'supersedesLineId'],
  },
};

const KNOWN_OUTCOMES: ReadonlySet<unknown> = new Set(OUTCOMES);

// Whether an answer has the result's shape as far as it holds without the schema: this contract's
// version, a known outcome, every field that outcome requires and none it forbids. The type of each
// field is the schema's to check, on the server, before the answer leaves.
export function hasResultShape(structured: unknown): boolean {
  if (typeof structured !== 'object' || structured === null) return false;
  const result = structured as Record<string, unknown>;
  if (result.contractVersion !== CONTRACT_VERSION || !KNOWN_OUTCOMES.has(result.outcome)) return false;
  const { requires, forbids } = OUTCOME_FIELDS[result.outcome as Outcome];
  return requires.every((field) => result[field] !== undefined) && forbids.every((field) => result[field] === undefined);
}

import { z } from 'zod';
import demoProfile from '../../data/kitchens/demo.json';

export const LOG_READING = 'log_reading';
export const CONTRACT_VERSION = 1;

export const OUTCOMES = ['in_range', 'out_of_range', 'refused', 'held', 'not_covered', 'nothing_to_fix'] as const;
export type Outcome = (typeof OUTCOMES)[number];

type IdList = [string, ...string[]];

const CHECK_POINT_IDS = demoProfile.checkPoints.map((point) => point.id) as IdList;
const MEASURE_IDS = ['air', ...demoProfile.foods.map((food) => food.id)] as IdList;

// Judged at the precision given and never rounded, so 41.4 stays above 41. The tolerance only
// absorbs binary representation error in the multiplication.
function hasAtMostOneDecimal(value: number): boolean {
  const tenths = value * 10;
  return Math.abs(tenths - Math.round(tenths)) < 1e-6;
}

// Absolute zero, rounded up to the tenth, and a figure past any kitchen probe. The bound also keeps
// the decimal check meaningful: far above it a number carries no tenths at all, so any huge value
// would pass as "one decimal place".
const LOWEST_READING_F = -459.6;
const HIGHEST_READING_F = 1000;

export const LogReadingInputSchema = z.object({
  check_point: z.enum(CHECK_POINT_IDS).optional(),
  value: z
    .number()
    .min(LOWEST_READING_F)
    .max(HIGHEST_READING_F)
    .refine(hasAtMostOneDecimal, { message: 'value takes at most one decimal place' })
    .optional(),
  measured: z.enum(MEASURE_IDS).optional(),
  words: z.string().max(200).optional(),
  initials: z.string().max(8).optional(),
  screen_id: z
    .string()
    .min(1)
    .max(64)
    .describe('Names the screen or device the cook speaks to. Send the same id on every call from that screen.'),
  request_id: z
    .string()
    .min(1)
    .max(64)
    .describe(
      'Send a new random id, such as a UUID, for every utterance, never a counter that starts again in a new ' +
        'conversation. Send the same id again only to retry the identical call right away: any other reuse is refused.',
    ),
  pending_prompt_id: z
    .string()
    .max(64)
    .optional()
    .describe(
      "The id of the question Tolsey just asked, taken from the last result's prompt.id. Send it with the cook's " +
        'answer to that question and leave it out otherwise: an answer sent without it is handled as a new call.',
    ),
});
export type LogReadingInput = z.infer<typeof LogReadingInputSchema>;

const CheckPointResultSchema = z.object({ id: z.string(), name: z.string() }).strict();

const RuleResultSchema = z
  .object({
    id: z.string(),
    section: z.string().optional(),
    comparator: z.enum(['at_most', 'at_least']),
    limit: z.number(),
    unit: z.literal('F'),
    sourceKind: z.enum(['food_code', 'other_law', 'house_rule']),
  })
  .strict();

const PromptResultSchema = z.object({ kind: z.string(), id: z.string() }).strict();

const FixResultSchema = z.object({ id: z.string(), deadline: z.string() }).strict();

const OutputObjectSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    outcome: z.enum(OUTCOMES),
    lineId: z.string().optional(),
    recordCode: z.string().optional(),
    checkPoint: CheckPointResultSchema.optional(),
    value: z.number().optional(),
    unit: z.literal('F').optional(),
    verdict: z.string(),
    rule: RuleResultSchema.optional(),
    serverTime: z.string(),
    businessDay: z.string(),
    timeZone: z.string(),
    initials: z.string().optional(),
    supersedesLineId: z.string().optional(),
    prompt: PromptResultSchema.optional(),
    fix: FixResultSchema.optional(),
  })
  .strict();

type OutputField = keyof z.infer<typeof OutputObjectSchema>;

interface OutcomeFields {
  requires: readonly OutputField[];
  forbids: readonly OutputField[];
}

const LINE_FIELDS: readonly OutputField[] = ['lineId', 'recordCode', 'checkPoint', 'value', 'unit', 'initials'];

// Refusing additional properties says nothing about which fields an outcome must carry, and the SDK
// validates structuredContent only against this schema, so each outcome's shape is held here.
const OUTCOME_FIELDS: Record<Outcome, OutcomeFields> = {
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

function checkOutcomeFields(result: z.infer<typeof OutputObjectSchema>, ctx: z.RefinementCtx): void {
  const { requires, forbids } = OUTCOME_FIELDS[result.outcome];
  for (const field of requires) {
    if (result[field] === undefined) {
      ctx.addIssue({ code: 'custom', path: [field], message: `${result.outcome} requires ${field}` });
    }
  }
  for (const field of forbids) {
    if (result[field] !== undefined) {
      ctx.addIssue({ code: 'custom', path: [field], message: `${result.outcome} carries no ${field}` });
    }
  }
  // A refusal line carries both; a receipt reply such as "Log it by hand" carries neither.
  if (result.outcome === 'refused' && result.recordCode !== undefined && result.lineId === undefined) {
    ctx.addIssue({ code: 'custom', path: ['recordCode'], message: 'refused carries a recordCode only beside a lineId' });
  }
}

export const LogReadingOutputSchema = OutputObjectSchema.superRefine(checkOutcomeFields);
export type LogReadingOutput = z.infer<typeof LogReadingOutputSchema>;
export type RuleResult = z.infer<typeof RuleResultSchema>;

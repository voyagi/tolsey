import { z } from 'zod';
import { isKnownTimeZone, validateDayStart } from './business-day';

const ComparatorSchema = z.enum(['at_most', 'at_least']);
export type Comparator = z.infer<typeof ComparatorSchema>;

const IdSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
const ClockSchema = z.string().regex(/^\d{2}:\d{2}$/);
const PositiveIntSchema = z.number().int().positive();

// A house rule carries a reason and never a section (strict refuses one), so no surface can show it
// with a Code citation. supports and device name the Code rules it serves without citing its value.
const RuleSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('food_code'),
      section: z.string().min(1),
      page: z.string().min(1),
      edition: z.string().min(1),
      quote: z.string().min(1),
      unchanged2026: z.boolean(),
      interpretation: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('other_law'),
      name: z.string().min(1),
      section: z.string().min(1),
      provision: z.string().min(1),
      quote: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('house_rule'),
      reason: z.string().min(1),
      supports: z.array(z.string().min(1)).min(1).optional(),
      device: z.string().min(1).optional(),
      tightens: IdSchema.optional(),
    })
    .strict(),
]);
export type RuleSource = z.infer<typeof RuleSourceSchema>;

const temperatureLimit = {
  id: IdSchema,
  comparator: ComparatorSchema,
  limitFTenths: z.number().int(),
  limitC: z.number(),
  source: RuleSourceSchema,
};

const TemperatureRowSchema = z.object({ kind: z.literal('temperature'), ...temperatureLimit }).strict();
export type TemperatureRow = z.infer<typeof TemperatureRowSchema>;

const TimedTemperatureRowSchema = z
  .object({
    kind: z.literal('timed_temperature'),
    ...temperatureLimit,
    withinMinutes: PositiveIntSchema.optional(),
    fromFTenths: z.number().int().optional(),
    holdSeconds: PositiveIntSchema.optional(),
  })
  .strict();

const DurationRowSchema = z
  .object({
    kind: z.literal('duration'),
    id: IdSchema,
    minutes: PositiveIntSchema,
    times: z.string().min(1),
    fromFTenths: z.number().int().optional(),
    source: RuleSourceSchema,
  })
  .strict();

const ObservationRowSchema = z
  .object({
    kind: z.literal('observation'),
    id: IdSchema,
    states: z.array(z.string().min(1)).min(2),
    passingStates: z.array(z.string().min(1)).min(1),
    source: RuleSourceSchema,
  })
  .strict();

// One strict member per kind, so a clock, deadline or observation row can never be handed an
// invented temperature limit, and only a temperature row reaches the judge.
const RuleRowSchema = z.discriminatedUnion('kind', [
  TemperatureRowSchema,
  TimedTemperatureRowSchema,
  DurationRowSchema,
  ObservationRowSchema,
]);
export type RuleRow = z.infer<typeof RuleRowSchema>;

const NotCoveredSchema = z.object({ section: z.string().min(1), description: z.string().min(1) }).strict();

function addIssue(ctx: z.RefinementCtx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: 'custom', path, message });
}

function checkRow(row: RuleRow, index: number, ids: ReadonlySet<string>, ctx: z.RefinementCtx): void {
  const path = ['rows', index];
  if (row.kind === 'timed_temperature' && row.withinMinutes === undefined && row.holdSeconds === undefined) {
    addIssue(ctx, path, `${row.id} is timed but carries no time bound`);
  }
  if (row.kind === 'observation' && !row.passingStates.every((state) => row.states.includes(state))) {
    addIssue(ctx, path, `${row.id} passes a state it does not list`);
  }
  if (row.source.kind === 'house_rule' && row.source.tightens !== undefined && !ids.has(row.source.tightens)) {
    addIssue(ctx, path, `${row.id} tightens ${row.source.tightens}, which the table lacks`);
  }
}

export const RuleTableSchema = z
  .object({
    rulesVersion: z.string().min(1),
    edition: z.string().min(1),
    rows: z.array(RuleRowSchema).min(1),
    notCovered: z.array(NotCoveredSchema),
  })
  .strict()
  .superRefine((table, ctx) => {
    const ids = new Set(table.rows.map((row) => row.id));
    if (ids.size !== table.rows.length) addIssue(ctx, ['rows'], 'two rows share an id');
    table.rows.forEach((row, index) => checkRow(row, index, ids, ctx));
  });
export type RuleTable = z.infer<typeof RuleTableSchema>;

// Cooling and reheat readings are kept but not judged in phase 1, so those kinds carry no rules.
const CheckPointKindSchema = z.enum(['cold', 'hot', 'receiving', 'freezer', 'cooling', 'reheat']);
export type CheckPointKind = z.infer<typeof CheckPointKindSchema>;

const CheckPointSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    askAs: z.string().min(1),
    kind: CheckPointKindSchema,
    aliases: z.array(z.string().min(1)),
    airRule: IdSchema.optional(),
    foodRule: IdSchema.optional(),
    roastRule: IdSchema.optional(),
    foodRules: z.record(IdSchema, IdSchema).optional(),
    defaultMeasured: IdSchema.optional(),
  })
  .strict();
export type CheckPoint = z.infer<typeof CheckPointSchema>;

const FoodSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    aliases: z.array(z.string().min(1)),
    roast: z.literal(true).optional(),
  })
  .strict();

const ScheduleEntrySchema = z
  .object({
    id: IdSchema,
    checkPoint: IdSchema,
    check: z.enum(['hot_holding', 'cold_holding']),
    times: z.array(ClockSchema).min(1),
    intervalRule: IdSchema,
    graceMinutes: PositiveIntSchema,
  })
  .strict();

const ChecklistItemSchema = z.object({ id: IdSchema, text: z.string().min(1) }).strict();

const CoarseBandSchema = z
  .object({ lowF: z.number(), highF: z.number() })
  .strict()
  .refine((band) => band.lowF < band.highF, { message: 'a coarse band runs from low to high' });

export const KitchenProfileSchema = z
  .object({
    // Refused at load, like the day start below, so an unknown zone never reaches a shift.
    timeZone: z.string().refine(isKnownTimeZone, { message: 'time zone must be a zone name Intl knows, such as America/Chicago' }),
    // Refused at load, so a profile starting its day inside a clock change never reaches a shift.
    dayStart: z.string().refine(validateDayStart, { message: 'day start must be HH:MM outside 01:00 to 03:00' }),
    roster: z.array(z.string().regex(/^[A-Z]{2,3}$/)).min(1),
    foods: z.array(FoodSchema).min(1),
    checkPoints: z.array(CheckPointSchema).min(1),
    schedule: z.array(ScheduleEntrySchema).min(1),
    checklist: z
      .object({ opening: z.array(ChecklistItemSchema).min(1), closing: z.array(ChecklistItemSchema).min(1) })
      .strict(),
    noTimeAsPublicHealthControl: z.string().min(1),
    correctionWindowSeconds: PositiveIntSchema,
    promptExpirySeconds: PositiveIntSchema,
    coarseBands: z.record(CheckPointKindSchema, CoarseBandSchema),
    vocabulary: z
      .object({
        verbs: z.array(z.string().min(1)),
        articles: z.array(z.string().min(1)),
        nouns: z.array(z.string().min(1)),
        states: z.array(z.string().min(1)).min(1),
        // How a number said as a limit, a range or a guess is told from a reading (REFU-01).
        hedges: z
          .object({
            limits: z.array(z.string().min(1)).min(1),
            below: z.string().min(1),
            zero: z.string().min(1),
            approximations: z.array(z.string().min(1)).min(1),
            decades: z.array(z.string().min(1)).min(1),
            tens: z.array(z.string().min(1)).min(1),
            ranges: z.array(z.string().min(1)).min(1),
            phrases: z.array(z.string().min(1)).min(1),
          })
          .strict()
          .refine((hedges) => hedges.limits.includes(hedges.below), {
            message: 'the word that makes a negative ("5 below") is also a limit word ("below 5")',
          }),
      })
      .strict(),
  })
  .strict();
export type KitchenProfile = z.infer<typeof KitchenProfileSchema>;

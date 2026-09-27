import { z } from 'zod';

export const ComparatorSchema = z.enum(['at_most', 'at_least']);
export type Comparator = z.infer<typeof ComparatorSchema>;

// A house rule carries a reason and never a section, so no surface can show it with a Code citation.
export const RuleSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('food_code'),
      section: z.string().min(1),
      page: z.string().min(1),
      edition: z.string().min(1),
      quote: z.string().min(1),
      unchanged2026: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('other_law'),
      name: z.string().min(1),
      section: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('house_rule'),
      reason: z.string().min(1),
    })
    .strict(),
]);
export type RuleSource = z.infer<typeof RuleSourceSchema>;

const TemperatureRowSchema = z
  .object({
    kind: z.literal('temperature'),
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    comparator: ComparatorSchema,
    limitFTenths: z.number().int(),
    limitC: z.number(),
    source: RuleSourceSchema,
  })
  .strict();
export type TemperatureRow = z.infer<typeof TemperatureRowSchema>;

// A union on kind from the first row, so the timed, duration and observation shapes join as members
// and a row with no temperature limit is never forced to carry one.
export const RuleRowSchema = z.discriminatedUnion('kind', [TemperatureRowSchema]);
export type RuleRow = z.infer<typeof RuleRowSchema>;

export const RuleTableSchema = z
  .object({
    rulesVersion: z.string().min(1),
    edition: z.string().min(1),
    rows: z.array(RuleRowSchema).min(1),
  })
  .strict();
export type RuleTable = z.infer<typeof RuleTableSchema>;

const IdSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);

// Cooling and reheat readings are kept but not judged in phase 1, so those kinds carry no rules.
export const CheckPointKindSchema = z.enum(['cold', 'hot', 'receiving', 'freezer', 'cooling', 'reheat']);
export type CheckPointKind = z.infer<typeof CheckPointKindSchema>;

const CheckPointSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
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
export type Food = z.infer<typeof FoodSchema>;

export const KitchenProfileSchema = z
  .object({
    timeZone: z.string().min(1),
    dayStart: z.string().regex(/^\d{2}:\d{2}$/),
    roster: z.array(z.string().regex(/^[A-Z]{2,3}$/)).min(1),
    foods: z.array(FoodSchema).min(1),
    checkPoints: z.array(CheckPointSchema).min(1),
    vocabulary: z
      .object({
        verbs: z.array(z.string().min(1)),
        articles: z.array(z.string().min(1)),
      })
      .strict(),
  })
  .strict();
export type KitchenProfile = z.infer<typeof KitchenProfileSchema>;

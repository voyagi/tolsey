import { z } from 'zod';
import demoJson from '../../data/kitchens/demo.json';
import rulesJson from '../../data/rules/food-code-2022.json';
import limitsJson from '../../data/store/limits.json';
import rowsPerWriteJson from '../../data/store/rows-per-write.json';
import { KitchenProfileSchema, RuleTableSchema, type KitchenProfile, type RuleRow } from '../domain/rule';
import type { RowsPerWrite } from '../store/port';

const StoreLimitsSchema = z
  .object({
    dailyRowCap: z.number().int().positive(),
    kitchenLineCap: z.number().int().positive(),
    writeWindowHours: z.number().positive(),
    retentionAgeHours: z.number().positive(),
    retryWindowSeconds: z.number().positive(),
    sweepBatchLimit: z.number().int().positive(),
    cronSweepBatchLimit: z.number().int().positive(),
    maxSweepRounds: z.number().int().positive(),
  })
  .strict();
export type StoreLimits = z.infer<typeof StoreLimitsSchema>;

const RowsPerWriteSchema = z
  .object({
    measuredOn: z.string().min(1),
    kitchen_create: z.number().int().positive(),
    event_first_of_day: z.number().int().positive(),
    event: z.number().int().positive(),
    event_superseding: z.number().int().positive(),
    event_answering: z.number().int().positive(),
    budget_add: z.number().int().positive(),
  })
  .strict();

const table = RuleTableSchema.parse(rulesJson);

export const RULES: ReadonlyMap<string, RuleRow> = new Map(table.rows.map((row) => [row.id, row]));
export const RULES_VERSION = table.rulesVersion;
export const DEMO_PROFILE: KitchenProfile = KitchenProfileSchema.parse(demoJson);
export const STORE_LIMITS: StoreLimits = StoreLimitsSchema.parse(limitsJson);
export const ROWS_PER_WRITE: RowsPerWrite = RowsPerWriteSchema.parse(rowsPerWriteJson);

// A profile that names a missing rule or an unknown default measure fails at load, never at the
// first reading of a shift.
const measures = new Set(['air', ...DEMO_PROFILE.foods.map((food) => food.id)]);
for (const point of DEMO_PROFILE.checkPoints) {
  const named = [point.airRule, point.foodRule, point.roastRule, ...Object.values(point.foodRules ?? {})];
  for (const ruleId of named) {
    if (ruleId !== undefined && !RULES.has(ruleId)) {
      throw new Error(`check point ${point.id} names rule ${ruleId}, which the rule table lacks`);
    }
  }
  if (point.defaultMeasured !== undefined && !measures.has(point.defaultMeasured)) {
    throw new Error(`check point ${point.id} defaults to ${point.defaultMeasured}, which is not a known measure`);
  }
}

import type { LogReadingInput, LogReadingOutput, RuleResult } from '../contract/log-reading';
import { judgeReading } from './judge';
import {
  baseEvent,
  baseOutput,
  decided,
  NO_LINKS,
  type Decision,
  type DecisionContext,
  type Facts,
  type Links,
} from './decision';
import { decideRefusal } from './refusal';
import type { CheckPoint, CheckPointKind, KitchenProfile, RuleRow, RuleSource, TemperatureRow } from './rule';
import { formatValue, rebuildWords } from './words';

export type { Decision, DecisionContext, Rejection, ToolResultTemplate } from './decision';

const TENTHS_PER_DEGREE = 10;

export function spokenReadback(outcome: LogReadingOutput): string {
  const parts = [outcome.checkPoint?.name, outcome.value === undefined ? undefined : formatValue(outcome.value)];
  return [...parts, outcome.verdict, outcome.initials].filter((part) => part !== undefined).join(', ');
}

function sectionOf(source: RuleSource): string | undefined {
  return source.kind === 'house_rule' ? undefined : source.section;
}

function ruleResult(rule: TemperatureRow): RuleResult {
  const section = sectionOf(rule.source);
  return {
    id: rule.id,
    ...(section === undefined ? {} : { section }),
    comparator: rule.comparator,
    limit: rule.limitFTenths / TENTHS_PER_DEGREE,
    unit: 'F',
    sourceKind: rule.source.kind,
  };
}

function checkPointFor(profile: KitchenProfile, id: string): CheckPoint {
  const point = profile.checkPoints.find((candidate) => candidate.id === id);
  if (!point) throw new Error('check point missing from the kitchen profile');
  return point;
}

// Phase 1 has no judging path for these kinds, so their readings are kept unjudged rather than
// measured against a neighbouring row (D-06).
const UNJUDGED_KINDS: ReadonlySet<CheckPointKind> = new Set(['cooling', 'reheat']);

function ruleIdFor(checkPoint: CheckPoint, measured: string, profile: KitchenProfile): string | undefined {
  if (measured === 'air') return checkPoint.airRule;
  const own = checkPoint.foodRules;
  if (own && Object.hasOwn(own, measured)) return own[measured];
  const food = profile.foods.find((candidate) => candidate.id === measured);
  if (food?.roast && checkPoint.roastRule) return checkPoint.roastRule;
  return checkPoint.foodRule;
}

// Only a temperature row holds a single-reading limit; every other outcome of the selection, a
// missing row included, is not_covered and never reaches the judge or the adapter's fault path.
export function selectRule(
  checkPoint: CheckPoint,
  measured: string | undefined,
  profile: KitchenProfile,
  rules: ReadonlyMap<string, RuleRow>,
): TemperatureRow | undefined {
  if (UNJUDGED_KINDS.has(checkPoint.kind) || measured === undefined) return undefined;
  const ruleId = ruleIdFor(checkPoint, measured, profile);
  const row = ruleId === undefined ? undefined : rules.get(ruleId);
  return row?.kind === 'temperature' ? row : undefined;
}

// A host transcribing spelled letters sends "ab", "A.B." or "a b"; a stored line carries the
// roster's own form.
function rosterInitials(initials: string): string {
  return initials.replace(/[^A-Za-z]/g, '').toUpperCase();
}

interface Judged {
  outcome: 'in_range' | 'out_of_range' | 'not_covered';
  rule: TemperatureRow | undefined;
}

function judge(valueTenths: number, rule: TemperatureRow | undefined): Judged {
  return rule === undefined ? { outcome: 'not_covered', rule } : { outcome: judgeReading(valueTenths, rule), rule };
}

interface ReadingFacts extends Facts {
  checkPoint: CheckPoint;
  value: number;
  initials: string;
}

function readingDecision(facts: ReadingFacts, ctx: DecisionContext, links: Links): Decision {
  const { checkPoint, value } = facts;
  const measured = facts.measured ?? checkPoint.defaultMeasured;
  const valueTenths = Math.round(value * TENTHS_PER_DEGREE);
  const { outcome, rule } = judge(valueTenths, selectRule(checkPoint, measured, ctx.profile, ctx.rules));
  const lineId = ctx.newId();
  const structured: LogReadingOutput = {
    ...baseOutput(ctx, facts, outcome),
    lineId,
    value,
    unit: 'F',
    ...(rule === undefined ? {} : { rule: ruleResult(rule) }),
  };
  const event = {
    ...baseEvent(ctx, { ...facts, measured }, 'reading', lineId, links),
    words: rebuildWords(facts.words, ctx.profile, value, checkPoint),
    valueTenths,
    unit: 'F' as const,
    outcome,
    verdict: rule === undefined ? null : structured.verdict,
    ruleId: rule?.id ?? null,
    ruleSnapshot: rule === undefined ? null : JSON.stringify(rule),
    rulesVersion: ctx.rulesVersion,
  };
  return decided(event, spokenReadback(structured), structured);
}

function callFacts(input: LogReadingInput, ctx: DecisionContext, initials: string | undefined): Facts {
  return {
    checkPoint: input.check_point === undefined ? undefined : checkPointFor(ctx.profile, input.check_point),
    value: input.value,
    measured: input.measured,
    initials,
    words: input.words,
    screenId: input.screen_id,
    requestId: input.request_id,
  };
}

// The roster check is the first decision: a refusal or a hold stores the call's initials, so text
// that is not a roster entry must be turned away before anything can be written (PRIV-01).
export function decideLogReading(input: LogReadingInput, ctx: DecisionContext): Decision {
  const initials = input.initials === undefined ? undefined : rosterInitials(input.initials);
  if (initials !== undefined && !ctx.profile.roster.includes(initials)) {
    return { status: 'rejected', code: 'initials_not_on_roster' };
  }
  const facts = callFacts(input, ctx, initials);
  const refusal = decideRefusal(facts, ctx, NO_LINKS);
  if (refusal) return refusal;

  const { checkPoint, value } = facts;
  if (checkPoint === undefined || value === undefined || initials === undefined) {
    return { status: 'rejected', code: 'not_handled_yet' };
  }
  return readingDecision({ ...facts, checkPoint, value, initials }, ctx, NO_LINKS);
}

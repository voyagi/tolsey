import type { LogReadingInput, LogReadingOutput, Outcome, RuleResult } from '../contract/log-reading';
import type { NewEvent } from '../store/port';
import { businessDay, utcIso } from './business-day';
import { judgeReading } from './judge';
import type { CheckPoint, CheckPointKind, KitchenProfile, RuleRow, RuleSource, TemperatureRow } from './rule';

export interface DecisionContext {
  now: number;
  newId: () => string;
  kitchen: { id: string; timeZone: string; dayStart: string };
  rules: ReadonlyMap<string, RuleRow>;
  rulesVersion: string;
  profile: KitchenProfile;
}

export interface ToolResultTemplate {
  content: [{ type: 'text'; text: string }];
  structuredContent: LogReadingOutput;
}

export type Rejection = 'initials_not_on_roster' | 'not_handled_yet';

export type Decision =
  | { status: 'decided'; event: Omit<NewEvent, 'argsHash'>; result: ToolResultTemplate }
  | { status: 'rejected'; code: Rejection };

const TENTHS_PER_DEGREE = 10;

const VERDICT_WORDS: Record<Outcome, string> = {
  in_range: 'in range',
  out_of_range: 'out of range',
  refused: 'refused',
  held: 'held',
  not_covered: 'not covered yet',
  nothing_to_fix: 'nothing to fix',
};

const recognisedByProfile = new WeakMap<KitchenProfile, ReadonlySet<string>>();

function recognisedTokens(profile: KitchenProfile): ReadonlySet<string> {
  let tokens = recognisedByProfile.get(profile);
  if (!tokens) {
    const phrases = [...profile.checkPoints, ...profile.foods].flatMap((named) => [named.name, ...named.aliases]);
    tokens = new Set([
      ...phrases.flatMap((phrase) => [phrase.toLowerCase(), ...tokensOf(phrase)]),
      ...profile.vocabulary.verbs,
      ...profile.vocabulary.articles,
    ]);
    recognisedByProfile.set(profile, tokens);
  }
  return tokens;
}

function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9.-]+/)
    .map((token) => token.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean);
}

function formatValue(value: number): string {
  return String(value);
}

// Only recognised tokens and the number itself persist, so no visitor free text or markup reaches
// the record (BUILD-SPEC A7).
export function rebuildWords(
  raw: string | undefined,
  profile: KitchenProfile,
  value: number,
  checkPoint: CheckPoint,
): string {
  const number = formatValue(value);
  const known = recognisedTokens(profile);
  const kept = raw === undefined ? [] : tokensOf(raw).filter((token) => token === number || known.has(token));
  return kept.length > 0 ? kept.join(' ') : `${checkPoint.name.toLowerCase()} ${number}`;
}

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

function rosterInitials(initials: string): string {
  return initials.replace(/[^A-Za-z]/g, '').toUpperCase();
}

interface Judged {
  outcome: Outcome;
  rule: TemperatureRow | undefined;
}

function judge(valueTenths: number, rule: TemperatureRow | undefined): Judged {
  return rule === undefined ? { outcome: 'not_covered', rule } : { outcome: judgeReading(valueTenths, rule), rule };
}

export function decideLogReading(input: LogReadingInput, ctx: DecisionContext): Decision {
  const { check_point: checkPointId, value, initials } = input;
  if (checkPointId === undefined || value === undefined || initials === undefined) {
    return { status: 'rejected', code: 'not_handled_yet' };
  }
  const person = rosterInitials(initials);
  if (!ctx.profile.roster.includes(person)) return { status: 'rejected', code: 'initials_not_on_roster' };

  const checkPoint = checkPointFor(ctx.profile, checkPointId);
  const measured = input.measured ?? checkPoint.defaultMeasured;
  const valueTenths = Math.round(value * TENTHS_PER_DEGREE);
  const { outcome, rule } = judge(valueTenths, selectRule(checkPoint, measured, ctx.profile, ctx.rules));
  const day = businessDay(ctx.now, ctx.kitchen.timeZone, ctx.kitchen.dayStart);
  const lineId = ctx.newId();

  const structured: LogReadingOutput = {
    contractVersion: 1,
    outcome,
    lineId,
    checkPoint: { id: checkPoint.id, name: checkPoint.name },
    value,
    unit: 'F',
    verdict: VERDICT_WORDS[outcome],
    ...(rule === undefined ? {} : { rule: ruleResult(rule) }),
    serverTime: utcIso(ctx.now),
    businessDay: day,
    timeZone: ctx.kitchen.timeZone,
    initials: person,
  };

  const event: Omit<NewEvent, 'argsHash'> = {
    id: lineId,
    kitchenId: ctx.kitchen.id,
    kind: 'reading',
    occurredAt: ctx.now,
    businessDay: day,
    timeZone: ctx.kitchen.timeZone,
    screenId: input.screen_id,
    requestId: input.request_id,
    origin: 'person',
    checkPointId: checkPoint.id,
    measured: measured ?? null,
    initials: person,
    words: rebuildWords(input.words, ctx.profile, value, checkPoint),
    valueTenths,
    unit: 'F',
    outcome,
    verdict: rule === undefined ? null : structured.verdict,
    ruleId: rule?.id ?? null,
    ruleSnapshot: rule === undefined ? null : JSON.stringify(rule),
    rulesVersion: ctx.rulesVersion,
    supersedesId: null,
    rootId: null,
    refId: null,
    answersId: null,
    promptKind: null,
    expiresAt: null,
    dueSlotId: null,
    dueAt: null,
  };

  return {
    status: 'decided',
    event,
    result: { content: [{ type: 'text', text: spokenReadback(structured) }], structuredContent: structured },
  };
}

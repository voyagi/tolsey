import type { LogReadingInput, LogReadingOutput, Outcome, RuleResult } from '../contract/log-reading';
import type { NewEvent } from '../store/port';
import { businessDay, utcIso } from './business-day';
import { judgeReading } from './judge';
import type { CheckPoint, KitchenProfile, RuleRow, RuleSource } from './rule';

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
    const phrases = profile.checkPoints.flatMap((point) => [point.name, ...point.aliases]);
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

function ruleResult(rule: RuleRow): RuleResult {
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

function ruleFor(checkPoint: CheckPoint, measured: string, rules: ReadonlyMap<string, RuleRow>): RuleRow {
  const rule = rules.get(measured === 'air' ? checkPoint.airRule : checkPoint.foodRule);
  if (!rule) throw new Error('rule row missing from the rule table');
  return rule;
}

function rosterInitials(initials: string): string {
  return initials.replace(/[^A-Za-z]/g, '').toUpperCase();
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
  const rule = ruleFor(checkPoint, measured, ctx.rules);
  const valueTenths = Math.round(value * TENTHS_PER_DEGREE);
  const outcome = judgeReading(valueTenths, rule);
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
    rule: ruleResult(rule),
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
    measured,
    initials: person,
    words: rebuildWords(input.words, ctx.profile, value, checkPoint),
    valueTenths,
    unit: 'F',
    outcome,
    verdict: structured.verdict,
    ruleId: rule.id,
    ruleSnapshot: JSON.stringify(rule),
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

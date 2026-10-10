import type { LogReadingOutput, Outcome } from '../contract/log-reading';
import type { EventKind, NewEvent, PendingPrompt, ScreenEvent } from '../store/port';
import { businessDay } from './business-day';
import { utcIso } from './instant';
import type { CheckPoint, KitchenProfile, RuleRow } from './rule';

export interface DecisionContext {
  now: number;
  newId: () => string;
  kitchen: { id: string; timeZone: string; dayStart: string };
  rules: ReadonlyMap<string, RuleRow>;
  rulesVersion: string;
  profile: KitchenProfile;
  // The prompt named by pending_prompt_id, read by the adapter before deciding; null when the id
  // names nothing this kitchen asked.
  prompt?: PendingPrompt | null;
  // The newest event this screen wrote within the longer of the correction window and the prompt
  // expiry, read by the adapter only for a call whose words say "wrong number".
  latest?: ScreenEvent | null;
}

export interface ToolResultTemplate {
  content: [{ type: 'text'; text: string }];
  structuredContent: LogReadingOutput;
}

export type Rejection = 'initials_not_on_roster';

// Every question a decision can store as a prompt. The answer table in prompts.ts is typed by this
// union, so a new kind is a compile error until that table says how it is answered.
export type PromptKind = 'number' | 'digit_repeat' | 'which_check' | 'who_is_logging' | 'number_after_wrong';

export type DecidedEvent = Omit<NewEvent, 'argsHash'>;

export interface Decided {
  status: 'decided';
  event: DecidedEvent;
  result: ToolResultTemplate;
}

export type Decision = Decided | { status: 'rejected'; code: Rejection };

// What a decision works from: the call's own facts, with an answered prompt's held facts filled in,
// and initials already in the roster's form.
export interface Facts {
  checkPoint?: CheckPoint;
  value?: number;
  measured?: string;
  initials?: string;
  words?: string;
  screenId: string;
  requestId: string;
}

export interface Links {
  answersId: string | null;
  refId: string | null;
}

export const NO_LINKS: Links = { answersId: null, refId: null };

const VERDICT_WORDS: Record<Outcome, string> = {
  in_range: 'in range',
  out_of_range: 'out of range',
  refused: 'refused',
  held: 'held',
  not_covered: 'not covered yet',
  nothing_to_fix: 'nothing to fix',
};

export function checkPointFor(profile: KitchenProfile, id: string | null): CheckPoint {
  const point = profile.checkPoints.find((candidate) => candidate.id === id);
  if (!point) {
    const error = new Error('check point missing from the kitchen profile');
    error.name = 'UnknownCheckPoint';
    throw error;
  }
  return point;
}

export function optionalCheckPoint(profile: KitchenProfile, id: string | null | undefined): CheckPoint | undefined {
  return id === undefined || id === null ? undefined : checkPointFor(profile, id);
}

function dayOf(ctx: DecisionContext): string {
  return businessDay(ctx.now, ctx.kitchen.timeZone, ctx.kitchen.dayStart);
}

export function baseOutput(ctx: DecisionContext, facts: Facts, outcome: Outcome): LogReadingOutput {
  const { checkPoint, initials } = facts;
  return {
    contractVersion: 1,
    outcome,
    ...(checkPoint === undefined ? {} : { checkPoint: { id: checkPoint.id, name: checkPoint.name } }),
    verdict: VERDICT_WORDS[outcome],
    serverTime: utcIso(ctx.now),
    businessDay: dayOf(ctx),
    timeZone: ctx.kitchen.timeZone,
    ...(initials === undefined ? {} : { initials }),
  };
}

// Every column null or empty except what identifies the call; each builder fills in its own kind.
export function baseEvent(
  ctx: DecisionContext,
  facts: Facts,
  kind: EventKind,
  id: string,
  links: Links,
): DecidedEvent {
  return {
    id,
    kitchenId: ctx.kitchen.id,
    kind,
    occurredAt: ctx.now,
    businessDay: dayOf(ctx),
    timeZone: ctx.kitchen.timeZone,
    screenId: facts.screenId,
    requestId: facts.requestId,
    origin: 'person',
    checkPointId: facts.checkPoint?.id ?? null,
    measured: facts.measured ?? null,
    initials: facts.initials ?? null,
    words: '',
    valueTenths: null,
    unit: null,
    outcome: '',
    verdict: null,
    ruleId: null,
    ruleSnapshot: null,
    rulesVersion: null,
    supersedesId: null,
    rootId: null,
    refId: links.refId,
    answersId: links.answersId,
    promptKind: null,
    expiresAt: null,
    dueSlotId: null,
    dueAt: null,
  };
}

export function decided(event: DecidedEvent, text: string, structuredContent: LogReadingOutput): Decision {
  return { status: 'decided', event, result: { content: [{ type: 'text', text }], structuredContent } };
}

export const TENTHS_PER_DEGREE = 10;

export function tenthsOf(value: number): number {
  return Math.round(value * TENTHS_PER_DEGREE);
}

const SECOND_MS = 1000;

export function promptExpiry(ctx: DecisionContext): number {
  return ctx.now + ctx.profile.promptExpirySeconds * SECOND_MS;
}

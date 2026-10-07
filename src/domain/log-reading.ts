import type { LogReadingInput, LogReadingOutput, RuleResult } from '../contract/log-reading';
import { LOWEST_READING_F } from '../contract/reading-range';
import type { PendingPrompt, SupersedeTarget } from '../store/port';
import { decideCorrection } from './correction';
import { judgeReading } from './judge';
import {
  baseEvent,
  baseOutput,
  decided,
  NO_LINKS,
  optionalCheckPoint,
  promptExpiry,
  TENTHS_PER_DEGREE,
  tenthsOf,
  type Decided,
  type Decision,
  type DecisionContext,
  type Facts,
  type Links,
  type PromptKind,
} from './decision';
import { resolvePrompt, type PromptResolution } from './prompts';
import { digitRepeatReply, LOG_BY_HAND_REPLY, WHO_IS_LOGGING_REPLY, whichCheckReply } from './questions';
import { receiptDecision } from './receipt';
import { decideRefusal, refusalDecision } from './refusal';
import { temperatureRowFrom, type CheckPoint, type CheckPointKind, type KitchenProfile, type RuleRow, type RuleSource, type TemperatureRow } from './rule';
import { needsDigitRepeat } from './twins';
import {
  answerNumberWords,
  classifyNumberWords,
  formatValue,
  namesAFigure,
  rebuildWords,
  saysCorrection,
  tokensOf,
  type NumberWords,
} from './words';

export type { Decided, Decision, DecisionContext, Rejection } from './decision';

const ALREADY_ANSWERED_REPLY = 'That question was already answered. Say the check and its number again.';
const ALREADY_CORRECTED_REPLY = 'That reading was already corrected. Say the check and its number again.';

// READ-07: a different number is asked back once more, and the third miss in a row ends the chain.
const MISSES_BEFORE_LOG_BY_HAND = 3;

/** @public The read-back sentence of a judged reading, which the simulated wall speaks from phase 2. */
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

// A correction is judged by the rule the line said wrong was judged by, never the table as it is
// now. A line stored not_covered holds no rule, so its correction is not_covered too and is never
// judged by a neighbouring row (N5). A stored copy that no longer reads as a temperature row throws.
function ruleOfTarget(target: SupersedeTarget): TemperatureRow | undefined {
  return target.ruleSnapshot === null ? undefined : temperatureRowFrom(target.ruleSnapshot);
}

// A host transcribing spelled letters sends "ab", "A.B." or "a b"; a stored line carries the
// roster's own form. Only what is not a letter is dropped: a letter outside A to Z stays, and is never
// upper-cased into one (a dotless i would become I), so an accented E before AB is refused, never AB.
// Blank initials are no initials, so the reading is asked "Who is logging?".
function rosterInitials(initials: string | undefined): string | undefined {
  if (initials === undefined || initials.trim() === '') return undefined;
  const letters = initials.replace(/[^\p{L}]/gu, '');
  return /^[A-Za-z]*$/.test(letters) ? letters.toUpperCase() : letters;
}

interface Judged {
  outcome: 'in_range' | 'out_of_range' | 'not_covered';
  rule: TemperatureRow | undefined;
}

function judge(valueTenths: number, rule: TemperatureRow | undefined): Judged {
  return rule === undefined ? { outcome: 'not_covered', rule } : { outcome: judgeReading(valueTenths, rule), rule };
}

interface ValueFacts extends Facts {
  value: number;
}

interface ReadingFacts extends ValueFacts {
  checkPoint: CheckPoint;
  initials: string;
}

// A hold stores the number it holds, so the answer can be compared with it and the reading logged
// from it, and the question it asks is the prompt the answer names.
function heldDecision(facts: ValueFacts, ctx: DecisionContext, links: Links, promptKind: PromptKind, text: string): Decision {
  const promptId = ctx.newId();
  const measured = facts.measured ?? facts.checkPoint?.defaultMeasured;
  const event = {
    ...baseEvent(ctx, { ...facts, measured }, 'held', promptId, links),
    words: rebuildWords(facts.words, ctx.profile, facts.value, facts.checkPoint),
    valueTenths: tenthsOf(facts.value),
    unit: 'F' as const,
    outcome: 'held',
    rulesVersion: ctx.rulesVersion,
    promptKind,
    expiresAt: promptExpiry(ctx),
  };
  const structured: LogReadingOutput = {
    ...baseOutput(ctx, facts, 'held'),
    value: facts.value,
    unit: 'F',
    prompt: { kind: promptKind, id: promptId },
  };
  return decided(event, text, structured);
}

// The line a correction's confirmed number logs names the line said wrong in supersedes_id and takes
// its chain's root, so both partial unique indexes stand between it and a second superseding line.
function readingDecision(
  facts: ReadingFacts,
  ctx: DecisionContext,
  links: Links,
  row: TemperatureRow | undefined,
  supersede: SupersedeTarget | null,
): Decision {
  const { checkPoint, value } = facts;
  const valueTenths = tenthsOf(value);
  const { outcome, rule } = judge(valueTenths, row);
  const lineId = ctx.newId();
  const structured: LogReadingOutput = {
    ...baseOutput(ctx, facts, outcome),
    lineId,
    value,
    unit: 'F',
    ...(rule === undefined ? {} : { rule: ruleResult(rule) }),
    ...(supersede === null ? {} : { supersedesLineId: supersede.lineId }),
  };
  const event = {
    ...baseEvent(ctx, facts, 'reading', lineId, links),
    words: rebuildWords(facts.words, ctx.profile, value, checkPoint),
    valueTenths,
    unit: 'F' as const,
    outcome,
    verdict: rule === undefined ? null : structured.verdict,
    ruleId: rule?.id ?? null,
    ruleSnapshot: rule === undefined ? null : JSON.stringify(rule),
    rulesVersion: supersede === null ? ctx.rulesVersion : supersede.rulesVersion,
    supersedesId: supersede === null ? null : supersede.lineId,
    rootId: supersede === null ? null : supersede.rootId,
  };
  return decided(event, spokenReadback(structured), structured);
}

interface Answering {
  links: Links;
  valueFromCall: boolean;
  repeat?: PendingPrompt;
  // Set when the prompt answered belongs to a chain that started from "wrong number".
  supersede: SupersedeTarget | null;
}

const FRESH: Answering = { links: NO_LINKS, valueFromCall: true, supersede: null };

// A reading with no row is kept unjudged, and nothing unjudged can be misjudged, so only a reading
// with a row can be held; a confirmed digit repeat is judged without asking again.
function judgedOrHeld(facts: ReadingFacts, ctx: DecisionContext, answering: Answering, confirmed: boolean): Decision {
  const { checkPoint } = facts;
  const { links, supersede } = answering;
  const measured = facts.measured ?? checkPoint.defaultMeasured;
  const measuredFacts = { ...facts, measured };
  const row = supersede === null ? selectRule(checkPoint, measured, ctx.profile, ctx.rules) : ruleOfTarget(supersede);
  const band = ctx.profile.coarseBands[checkPoint.kind];
  if (row !== undefined && !confirmed && needsDigitRepeat(tenthsOf(facts.value), row, band)) {
    return heldDecision(measuredFacts, ctx, links, 'digit_repeat', digitRepeatReply(checkPoint));
  }
  return readingDecision(measuredFacts, ctx, links, row, supersede);
}

// A digit repeat prompt holds one number, the last one said. A different number answers it with a
// new hold on the same chain, whose first hold every later link names in ref_id, so the misses are
// counted along the chain; the third ends it with a receipt that answers the prompt, which closes it
// through the answers_id index so it can never be answered afterwards.
function nextRepeat(facts: ReadingFacts, ctx: DecisionContext, prompt: PendingPrompt): Decision {
  const links = { answersId: prompt.id, refId: prompt.refId ?? prompt.id };
  if (prompt.repeats + 1 >= MISSES_BEFORE_LOG_BY_HAND) {
    return receiptDecision(facts, ctx, { outcome: 'refused', text: LOG_BY_HAND_REPLY }, links);
  }
  return heldDecision(facts, ctx, links, 'digit_repeat', digitRepeatReply(facts.checkPoint));
}

// -0 equals 0, so this returns the literal 0 for both.
function unsignedZero(value: number): number {
  return value === 0 ? 0 : value;
}

// A hedge refuses the call even with a value attached, so a limit or a guess is never stored as the
// number the host put beside it (N1). "5 below" and "minus 5" make the value negative only when their
// digits are the value's own; any other pairing of words and value is not a reading. That holds the
// other way too: a figure said with no sign is above zero, so a negative value beside it would turn
// a failing freezer into a pass. A sign said before a number in words ("minus five") makes the value
// negative whatever sign the host gave it, but never below absolute zero, which the contract refuses
// in a value too. Zero takes no sign, so words that say a reading below zero refuse a 0 beside them
// whichever way they say it ("5 below", "minus five"), and a zero said with a sign ("0 below", "minus
// zero") reaches here as plain words. The contract and a JSON body both carry -0, which is stored as 0.
function valueAsSaid(value: number, said: NumberWords, figureSaid: boolean): number | undefined {
  if (said.kind === 'hedge') return undefined;
  if (said.kind === 'plain') return value < 0 && figureSaid ? undefined : unsignedZero(value);
  const magnitude = Math.abs(value);
  if (magnitude === 0) return undefined;
  if (said.magnitude !== undefined && said.magnitude !== magnitude) return undefined;
  return -magnitude >= LOWEST_READING_F ? -magnitude : undefined;
}

function valueFromWords(facts: Facts, ctx: DecisionContext): number | undefined {
  if (facts.value === undefined) return undefined;
  const tokens = tokensOf(facts.words ?? '');
  return valueAsSaid(facts.value, classifyNumberWords(tokens, ctx.profile), namesAFigure(tokens, ctx.profile));
}

// A fresh call and an answer run the same decision; an answer only arrives with the prompt's held
// facts filled in, so a number sent in answer to a refused walk-in is still held when it could be a
// misheard teen. A call missing both a check and initials is asked which check first. A hold or a
// refusal on the way to a correction's number never supersedes: only the line that logs does.
function decideFacts(facts: Facts, ctx: DecisionContext, answering: Answering): Decision {
  const { links } = answering;
  const refusal = decideRefusal(facts, ctx, links);
  if (refusal) return refusal;
  const value = answering.valueFromCall ? valueFromWords(facts, ctx) : facts.value;
  if (value === undefined) return refusalDecision(facts, ctx, links);
  const { checkPoint, initials } = facts;
  if (checkPoint === undefined) {
    return heldDecision({ ...facts, value }, ctx, links, 'which_check', whichCheckReply(value));
  }
  if (initials === undefined) return heldDecision({ ...facts, value }, ctx, links, 'who_is_logging', WHO_IS_LOGGING_REPLY);
  const reading = { ...facts, value, checkPoint, initials };
  const { repeat } = answering;
  // A digit repeat holds exactly one number, the last one said, and only that number confirms it: the
  // number this call gives once its words are read, so "5 below" beside the value 5 repeats a held -5.
  // A yes or a call with no value never gets here, since a call with no number is refused above.
  const confirms = repeat !== undefined && tenthsOf(value) === repeat.valueTenths;
  if (repeat !== undefined && !confirms) return nextRepeat(reading, ctx, repeat);
  return judgedOrHeld(reading, ctx, answering, confirms);
}

function callFacts(input: LogReadingInput, ctx: DecisionContext, initials: string | undefined): Facts {
  return {
    checkPoint: optionalCheckPoint(ctx.profile, input.check_point),
    value: input.value,
    measured: input.measured,
    initials,
    words: input.words,
    screenId: input.screen_id,
    requestId: input.request_id,
  };
}

type Answer = Extract<PromptResolution, { kind: 'answer' }>;

function decideAnswer(input: LogReadingInput, ctx: DecisionContext, answer: Answer): Decision {
  const { prompt, fill } = answer;
  const facts: Facts = {
    checkPoint: optionalCheckPoint(ctx.profile, fill.checkPoint),
    value: fill.value,
    measured: fill.measured,
    initials: fill.initials,
    words: input.words,
    screenId: input.screen_id,
    requestId: input.request_id,
  };
  const links = { answersId: prompt.id, refId: null };
  const supersede = prompt.supersedes;
  // Two "wrong number" calls racing on one line leave two questions about it. Once one is answered with
  // the corrected number, the other asks about a line already superseded, so whatever answers it hears
  // that, and the receipt answers the question: a hold or a refusal stored here would reopen the check
  // the corrected line closed.
  if (supersede?.superseded === true) return alreadyAnswered(input, ctx, prompt, links);
  if (answer.valueFromCall) {
    const repeat = prompt.promptKind === 'digit_repeat' ? prompt : undefined;
    return decideFacts(facts, ctx, { links, valueFromCall: true, repeat, supersede });
  }
  // An answer to which check or who is logging may say the held number again, with or without a value
  // beside it ("MR, about 38", "MR, 5 below"). A hedge in its words refuses the answer, and so does a
  // figure said with no sign beside a held number below zero. A sign gives the held number below zero,
  // still decided for the prompt's check and initials and answering the prompt. Words that say
  // neither ("MR", "MR, it's fine") leave the held number as it was.
  const tokens = tokensOf(input.words ?? '');
  const said = answerNumberWords(tokens, ctx.profile);
  const value = facts.value === undefined ? undefined : valueAsSaid(facts.value, said, namesAFigure(tokens, ctx.profile));
  if (value === undefined) return refusalDecision(facts, ctx, links);
  return decideFacts({ ...facts, value }, ctx, { links, valueFromCall: false, supersede });
}

// The one reply a second answer gets, whether the prompt was answered before this call read it or
// while this call was deciding (the adapter reads the prompt again after its conflict), so both are
// chosen from the same stored fact. It says the reading was corrected only when a line already
// supersedes the one said wrong: a correction's question that a hold, a refusal or "Log it by hand"
// answered has corrected nothing yet. The receipt answers only what links names: none for a second
// answer, whose answers_id the index already holds for the first, and none for the adapter's race
// fallback, which leaves its question open; the question's own links when an answer reaches an open
// question about a line another question already corrected, so that question closes.
export function alreadyAnswered(
  input: LogReadingInput,
  ctx: DecisionContext,
  prompt: PendingPrompt | null,
  links: Links = NO_LINKS,
): Decided {
  const facts = callFacts(input, ctx, rosterInitials(input.initials));
  const checkPoint = facts.checkPoint ?? optionalCheckPoint(ctx.profile, prompt?.checkPointId);
  const text = prompt?.supersedes?.superseded === true ? ALREADY_CORRECTED_REPLY : ALREADY_ANSWERED_REPLY;
  return receiptDecision({ ...facts, checkPoint }, ctx, { outcome: 'refused', text }, links);
}

// The roster check is the first decision: a refusal, a hold or a receipt stores the call's initials,
// so text that is not a roster entry must be turned away before anything can be written (PRIV-01). A
// correction comes next, before any prompt, refusal or judging: it is neither a numberless check nor a
// fresh reading, whatever number or check it carries.
export function decideLogReading(input: LogReadingInput, ctx: DecisionContext): Decision {
  const initials = rosterInitials(input.initials);
  if (initials !== undefined && !ctx.profile.roster.includes(initials)) {
    return { status: 'rejected', code: 'initials_not_on_roster' };
  }
  const call = { ...input, initials };
  if (saysCorrection(call.words, ctx.profile)) return decideCorrection(call, ctx, ctx.latest ?? null);
  const resolution = resolvePrompt(ctx.prompt ?? null, call, ctx.now);
  if (resolution.kind === 'already_answered') return alreadyAnswered(call, ctx, resolution.prompt);
  if (resolution.kind === 'answer') return decideAnswer(call, ctx, resolution);
  return decideFacts(callFacts(call, ctx, initials), ctx, FRESH);
}

import type { LogReadingInput } from '../contract/log-reading';
import type { ScreenEvent } from '../store/port';
import {
  baseEvent,
  baseOutput,
  checkPointFor,
  decided,
  NO_LINKS,
  optionalCheckPoint,
  promptExpiry,
  TENTHS_PER_DEGREE,
  type Decision,
  type DecisionContext,
  type Facts,
  type PromptKind,
} from './decision';
import { askAgainReply, digitRepeatReply, WHO_IS_LOGGING_REPLY, whichCheckReply } from './questions';
import { receiptDecision } from './receipt';
import type { CheckPoint } from './rule';
import { rebuildWords } from './words';

const NOTHING_TO_FIX_REPLY = 'Nothing to fix. Say a check and its number.';
const LOG_BY_HAND_REPLY = 'Log it by hand.';
const NUMBER_AFTER_WRONG: PromptKind = 'number_after_wrong';

// READ-05: a line already corrected twice is not asked about a third time.
const CORRECTIONS_BEFORE_LOG_BY_HAND = 3;

const SECOND_MS = 1000;

type CorrectionCall = Pick<LogReadingInput, 'initials' | 'words' | 'screen_id' | 'request_id'>;

function callFacts(input: CorrectionCall, checkPoint: CheckPoint | undefined): Facts {
  return {
    checkPoint,
    initials: input.initials,
    words: input.words,
    screenId: input.screen_id,
    requestId: input.request_id,
  };
}

function withinWindow(latest: ScreenEvent, ctx: DecisionContext): boolean {
  return ctx.now - latest.occurredAt <= ctx.profile.correctionWindowSeconds * SECOND_MS;
}

// A hold or a correction whose question is still open is the number Tolsey is holding right now, so
// "wrong number" is about that number and never about an older line behind it.
function asksStill(latest: ScreenEvent, ctx: DecisionContext): boolean {
  if (latest.kind !== 'held' && latest.kind !== 'wrong_number') return false;
  return !latest.answered && latest.expiresAt !== null && ctx.now < latest.expiresAt;
}

// The question the open prompt asked, asked again in the same words. A stored kind this code cannot
// ask is no question, and the call is answered as if nothing were open.
function questionOf(latest: ScreenEvent, checkPoint: CheckPoint | undefined): string | undefined {
  switch (latest.promptKind) {
    case 'who_is_logging':
      return WHO_IS_LOGGING_REPLY;
    case 'which_check':
      return latest.valueTenths === null ? undefined : whichCheckReply(latest.valueTenths / TENTHS_PER_DEGREE);
    case 'digit_repeat':
      return checkPoint && digitRepeatReply(checkPoint);
    case NUMBER_AFTER_WRONG:
      return checkPoint && askAgainReply(checkPoint);
    default:
      return undefined;
  }
}

function nothingToFix(input: CorrectionCall, ctx: DecisionContext): Decision {
  const receipt = { outcome: 'nothing_to_fix' as const, text: NOTHING_TO_FIX_REPLY };
  return receiptDecision(callFacts(input, undefined), ctx, receipt, NO_LINKS);
}

// The receipt names the open prompt in ref_id and answers nothing, so that prompt stays open for the
// number (E17).
function repeatQuestion(input: CorrectionCall, ctx: DecisionContext, latest: ScreenEvent): Decision {
  const checkPoint = optionalCheckPoint(ctx.profile, latest.checkPointId);
  const text = questionOf(latest, checkPoint);
  if (text === undefined || latest.promptKind === null) return nothingToFix(input, ctx);
  const receipt = { outcome: 'held' as const, text, prompt: { kind: latest.promptKind, id: latest.id } };
  return receiptDecision(callFacts(input, checkPoint), ctx, receipt, { answersId: null, refId: latest.id });
}

function logByHand(input: CorrectionCall, ctx: DecisionContext, line: ScreenEvent, checkPoint: CheckPoint): Decision {
  const receipt = { outcome: 'refused' as const, text: LOG_BY_HAND_REPLY };
  return receiptDecision(callFacts(input, checkPoint), ctx, receipt, { answersId: null, refId: line.id });
}

// The value a call sends beside the phrase is never used (D-05): one call stores one event, and it
// cannot be both the wrong_number event and the line that supersedes.
function sayWrong(input: CorrectionCall, ctx: DecisionContext, line: ScreenEvent): Decision {
  const checkPoint = checkPointFor(ctx.profile, line.checkPointId);
  if (line.corrections + 1 >= CORRECTIONS_BEFORE_LOG_BY_HAND) return logByHand(input, ctx, line, checkPoint);
  const facts = { ...callFacts(input, checkPoint), measured: line.measured ?? undefined };
  const promptId = ctx.newId();
  const event = {
    ...baseEvent(ctx, facts, 'wrong_number', promptId, { answersId: null, refId: line.id }),
    words: rebuildWords(input.words, ctx.profile, undefined, checkPoint),
    outcome: 'held',
    rulesVersion: ctx.rulesVersion,
    promptKind: NUMBER_AFTER_WRONG,
    expiresAt: promptExpiry(ctx),
  };
  const structured = { ...baseOutput(ctx, facts, 'held'), prompt: { kind: NUMBER_AFTER_WRONG, id: promptId } };
  return decided(event, askAgainReply(checkPoint), structured);
}

// latest is the newest event this screen wrote inside the window, receipts left out. A refusal is
// never superseded, and a hold whose question has closed holds nothing left to correct.
export function decideCorrection(input: CorrectionCall, ctx: DecisionContext, latest: ScreenEvent | null): Decision {
  if (latest === null || !withinWindow(latest, ctx)) return nothingToFix(input, ctx);
  if (latest.kind === 'reading') return sayWrong(input, ctx, latest);
  if (asksStill(latest, ctx)) return repeatQuestion(input, ctx, latest);
  return nothingToFix(input, ctx);
}

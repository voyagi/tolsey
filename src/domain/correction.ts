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
  type Decision,
  type DecisionContext,
  type Facts,
  type PromptKind,
} from './decision';
import { asksForNumber, isKnownKind } from './prompts';
import { askAgainReply, digitRepeatReply, LOG_BY_HAND_REPLY } from './questions';
import { receiptDecision } from './receipt';
import { refusalDecision } from './refusal';
import type { CheckPoint } from './rule';
import { rebuildWords } from './words';

const NOTHING_TO_FIX_REPLY = 'Nothing to fix. Say a check and its number.';
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

// The question the open prompt asked, asked again in the same words. Only a question the number
// answers is asked again, and one that names no check is no question this code can ask, so the call
// is answered as if nothing were open.
function questionOf(latest: ScreenEvent, checkPoint: CheckPoint | undefined): string | undefined {
  if (checkPoint === undefined) return undefined;
  switch (latest.promptKind) {
    case 'digit_repeat':
      return digitRepeatReply(checkPoint);
    case NUMBER_AFTER_WRONG:
      return askAgainReply(checkPoint);
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

// Which check and who is logging ask for something other than the number, and their answer logs the
// number the hold keeps. So "wrong number" said to one refuses that number the way a hedged answer
// does: a refusal answering the hold, which closes it for good and asks for the number again when the
// hold names a check.
function refuseHeld(input: CorrectionCall, ctx: DecisionContext, latest: ScreenEvent): Decision {
  const checkPoint = optionalCheckPoint(ctx.profile, latest.checkPointId);
  const facts = { ...callFacts(input, checkPoint), measured: latest.measured ?? undefined };
  return refusalDecision(facts, ctx, { answersId: latest.id, refId: null });
}

// A line said wrong gets a wrong_number marker pointing at it (READ-05), never an edit, and the marker
// keeps its check open until a new number is logged. The value a call sends beside the phrase is
// never used (D-05): one call stores one event, and it cannot be both the marker and the line that
// supersedes. A line already corrected twice is not asked about a third time: its marker asks
// nothing, so it holds no prompt, and the check stays open as it does after a third digit-repeat miss.
function sayWrong(input: CorrectionCall, ctx: DecisionContext, line: ScreenEvent): Decision {
  const checkPoint = checkPointFor(ctx.profile, line.checkPointId);
  const facts = { ...callFacts(input, checkPoint), measured: line.measured ?? undefined };
  const marker = {
    ...baseEvent(ctx, facts, 'wrong_number', ctx.newId(), { answersId: null, refId: line.id }),
    words: rebuildWords(input.words, ctx.profile, undefined, checkPoint),
    rulesVersion: ctx.rulesVersion,
  };
  if (line.corrections + 1 >= CORRECTIONS_BEFORE_LOG_BY_HAND) {
    return decided({ ...marker, outcome: 'refused' }, LOG_BY_HAND_REPLY, baseOutput(ctx, facts, 'refused'));
  }
  const event = { ...marker, outcome: 'held', promptKind: NUMBER_AFTER_WRONG, expiresAt: promptExpiry(ctx) };
  const structured = { ...baseOutput(ctx, facts, 'held'), prompt: { kind: NUMBER_AFTER_WRONG, id: marker.id } };
  return decided(event, askAgainReply(checkPoint), structured);
}

// latest is the newest event this screen wrote, receipts left out, read back as far as the longer of
// the correction window and the prompt expiry. The window bounds a line said wrong, while a question
// is correctable for as long as it is open, so each kind is held to its own limit here. A refusal is
// never superseded, and a hold whose question has closed holds nothing left to correct.
export function decideCorrection(input: CorrectionCall, ctx: DecisionContext, latest: ScreenEvent | null): Decision {
  if (latest === null) return nothingToFix(input, ctx);
  if (latest.kind === 'reading') return withinWindow(latest, ctx) ? sayWrong(input, ctx, latest) : nothingToFix(input, ctx);
  if (!asksStill(latest, ctx) || latest.promptKind === null) return nothingToFix(input, ctx);
  if (asksForNumber(latest.promptKind)) return repeatQuestion(input, ctx, latest);
  return isKnownKind(latest.promptKind) ? refuseHeld(input, ctx, latest) : nothingToFix(input, ctx);
}

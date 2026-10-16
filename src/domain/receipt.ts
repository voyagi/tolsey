import type { LogReadingOutput, Outcome } from '../contract/log-reading';
import {
  baseEvent,
  baseOutput,
  optionalCheckPoint,
  type Decided,
  type DecidedEvent,
  type DecisionContext,
  type Facts,
  type Links,
  type ToolResultTemplate,
} from './decision';
import { rebuildWords } from './words';

export interface Receipt {
  outcome: Outcome;
  text: string;
  prompt?: LogReadingOutput['prompt'];
}

// The one shape of a stored answer that records no line: it takes no day line and no record code,
// holds no value or verdict, and is skipped by open checks and counts. Storing it is what lets a
// retry inside the window get this reply back instead of being decided again against changed state.
function receiptEvent(facts: Facts, ctx: DecisionContext, result: ToolResultTemplate, links: Links): DecidedEvent {
  const { checkPoint, initials, outcome } = result.structuredContent;
  const point = optionalCheckPoint(ctx.profile, checkPoint?.id);
  const stored = { checkPoint: point, initials, screenId: facts.screenId, requestId: facts.requestId };
  return {
    ...baseEvent(ctx, stored, 'receipt', ctx.newId(), links),
    words: rebuildWords(facts.words, ctx.profile, undefined, point),
    outcome,
    rulesVersion: ctx.rulesVersion,
  };
}

export function receiptDecision(facts: Facts, ctx: DecisionContext, receipt: Receipt, links: Links): Decided {
  const structuredContent: LogReadingOutput = { ...baseOutput(ctx, facts, receipt.outcome) };
  if (receipt.prompt !== undefined) structuredContent.prompt = receipt.prompt;
  const result: ToolResultTemplate = { content: [{ type: 'text', text: receipt.text }], structuredContent };
  return { status: 'decided', event: receiptEvent(facts, ctx, result, links), result };
}

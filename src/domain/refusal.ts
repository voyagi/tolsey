import { baseEvent, baseOutput, decided, promptExpiry, type Decision, type DecisionContext, type Facts, type Links } from './decision';
import type { CheckPoint } from './rule';
import { rebuildWords } from './words';

const NO_CHECK_REPLY = 'I need a check and the number on the thermometer.';

/** @public The question asked back for a check given without a number. */
export function refusalReply(checkPoint: CheckPoint | undefined): string {
  if (checkPoint === undefined) return NO_CHECK_REPLY;
  return `I need the number on the thermometer. What does ${checkPoint.askAs} read?`;
}

// The refusal is also the question asking for the number, so it is stored as a prompt when there is
// a check to ask about. A call naming no check gets a reply that asks nothing, so it stores no
// prompt and opens no check.
export function refusalDecision(facts: Facts, ctx: DecisionContext, links: Links): Decision {
  const lineId = ctx.newId();
  const { checkPoint } = facts;
  const asks = checkPoint !== undefined;
  const event = {
    ...baseEvent(ctx, facts, 'refusal', lineId, links),
    words: rebuildWords(facts.words, ctx.profile, undefined, checkPoint),
    outcome: 'refused',
    rulesVersion: ctx.rulesVersion,
    promptKind: asks ? 'number' : null,
    expiresAt: asks ? promptExpiry(ctx) : null,
  };
  const structured = {
    ...baseOutput(ctx, facts, 'refused'),
    lineId,
    ...(asks ? { prompt: { kind: 'number', id: lineId } } : {}),
  };
  return decided(event, refusalReply(checkPoint), structured);
}

// A missing number is the domain's refusal, never a schema rejection: value stays optional in the
// contract (REFU-01), so a numberless check reaches here and is refused before any rule is chosen.
export function decideRefusal(facts: Facts, ctx: DecisionContext, links: Links): Decision | undefined {
  if (facts.value !== undefined) return undefined;
  return refusalDecision(facts, ctx, links);
}

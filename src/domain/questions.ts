import type { CheckPoint } from './rule';
import { formatValue } from './words';

export const WHO_IS_LOGGING_REPLY = 'Who is logging?';

// Both chains that end without a number send the cook to the same Log by hand form: a third "wrong
// number" about one line (READ-05) and a third digit-repeat miss (READ-07).
export const LOG_BY_HAND_REPLY = 'Log it by hand.';

export function askAgainReply(checkPoint: CheckPoint): string {
  return `What does ${checkPoint.askAs} read?`;
}

export function digitRepeatReply(checkPoint: CheckPoint): string {
  return `Say it one digit at a time. ${askAgainReply(checkPoint)}`;
}

export function whichCheckReply(value: number): string {
  return `Which check reads ${formatValue(value)}?`;
}

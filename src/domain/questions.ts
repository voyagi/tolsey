import type { CheckPoint } from './rule';
import { formatValue } from './words';

export const WHO_IS_LOGGING_REPLY = 'Who is logging?';

export function askAgainReply(checkPoint: CheckPoint): string {
  return `What does ${checkPoint.askAs} read?`;
}

export function digitRepeatReply(checkPoint: CheckPoint): string {
  return `Say it one digit at a time. ${askAgainReply(checkPoint)}`;
}

export function whichCheckReply(value: number): string {
  return `Which check reads ${formatValue(value)}?`;
}

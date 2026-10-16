// serverTime is the instant itself in UTC, never a calendar day: which day a line belongs to comes
// only from business-day.ts and the kitchen's wall clock.
export function utcIso(instantMs: number): string {
  return new Date(instantMs).toISOString();
}

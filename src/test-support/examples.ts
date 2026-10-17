import type { FetchLike } from '../client/mcp-client';
import type { KitchenProfile } from '../domain/rule';

export const CANONICAL_HOST = 'tolsey.taranity.com';

export const KEPT_HEADERS: readonly string[] = ['content-type', 'mcp-protocol-version'];

export interface PrivacyProblem {
  kind: string;
  file: string;
  where: string;
}

export type PrivacyCheck = { status: 'absent' } | { status: 'checked'; files: string[]; problems: PrivacyProblem[] };

export function privacyProblems(_dir: string, _roster: readonly string[]): PrivacyCheck {
  return { status: 'checked', files: [], problems: [] };
}

export interface RecordedExchange {
  method: string;
  path: string;
  status: number;
  request: { headers: Record<string, string>; body: unknown };
  response: { headers: Record<string, string>; body: unknown };
}

export function recordingFetch(inner: FetchLike): { fetch: FetchLike; exchanges: RecordedExchange[] } {
  return { fetch: inner, exchanges: [] };
}

export interface CaptureOptions {
  baseUrl: URL;
  fetch: FetchLike;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  gapMs: number;
  outDir: string;
  profile: KitchenProfile;
}

export async function runCapture(_options: CaptureOptions): Promise<void> {}

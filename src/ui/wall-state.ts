import type { ToolCallResult } from '../client/mcp-client';
import type { LogReadingOutput, Outcome } from '../contract/log-reading';
import type { KitchenProfile } from '../domain/rule';
import type { OpenPrompt } from './intent';

export type WallPhase = 'starting' | 'ready' | 'start_failed' | 'stopped';

export interface Exchange {
  said: string;
  reply: string;
  source: 'server' | 'wall';
}

type LoggedOutcome = Extract<Outcome, 'in_range' | 'out_of_range' | 'not_covered'>;

type PassField = 'lineId' | 'recordCode' | 'checkPoint' | 'value' | 'unit' | 'verdict' | 'rule' | 'initials';

export type Pass = Partial<Pick<LogReadingOutput, PassField>> & { outcome: LoggedOutcome };

export interface WallState {
  phase: WallPhase;
  startError: string | null;
  cook: string;
  exchange: Exchange | null;
  pass: Pass | null;
  openPrompt: OpenPrompt | null;
  inFlight: boolean;
}

export type WallEvent =
  | { type: 'starting' }
  | { type: 'started' }
  | { type: 'startFailed'; error: string }
  | { type: 'sent'; said: string }
  | { type: 'resultReceived'; said: string; result: ToolCallResult }
  | { type: 'wallReplied'; said: string; reply: string };

const LOGGED: ReadonlySet<string> = new Set<LoggedOutcome>(['in_range', 'out_of_range', 'not_covered']);

export function initialWallState(profile: KitchenProfile): WallState {
  return {
    phase: 'starting',
    startError: null,
    cook: profile.roster[0],
    exchange: null,
    pass: null,
    openPrompt: null,
    inFlight: false,
  };
}

// Only a logged line moves the pass, and only with the fields the server sent: the page never
// compares a value with a limit itself, so a refusal or a held reading can never read as logged.
function passFrom(structured: Partial<LogReadingOutput> | undefined, previous: Pass | null): Pass | null {
  if (structured?.outcome === undefined || !LOGGED.has(structured.outcome)) return previous;
  const { outcome, lineId, recordCode, checkPoint, value, unit, verdict, rule, initials } = structured;
  return { outcome: outcome as LoggedOutcome, lineId, recordCode, checkPoint, value, unit, verdict, rule, initials };
}

function afterResult(state: WallState, said: string, result: ToolCallResult): WallState {
  const structured = result.structuredContent as Partial<LogReadingOutput> | undefined;
  return {
    ...state,
    inFlight: false,
    exchange: { said, reply: result.content[0]?.text ?? '', source: 'server' },
    pass: passFrom(structured, state.pass),
    openPrompt: structured?.prompt ?? null,
  };
}

export function wallReducer(state: WallState, event: WallEvent): WallState {
  switch (event.type) {
    case 'starting':
      return { ...state, phase: 'starting', startError: null };
    case 'started':
      return { ...state, phase: 'ready', startError: null };
    case 'startFailed':
      return { ...state, phase: 'start_failed', startError: event.error };
    case 'sent':
      return { ...state, inFlight: true };
    case 'resultReceived':
      return afterResult(state, event.said, event.result);
    case 'wallReplied':
      return { ...state, inFlight: false, exchange: { said: event.said, reply: event.reply, source: 'wall' } };
  }
}

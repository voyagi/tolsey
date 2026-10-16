import type { ToolCallResult } from '../client/mcp-client';
import type { LogReadingOutput, Outcome } from '../contract/log-reading';
import type { KitchenProfile } from '../domain/rule';
import type { OpenPrompt } from './intent';
import { NEW_KITCHEN_SENTENCE } from './wall-copy';

type WallPhase = 'starting' | 'ready' | 'start_failed' | 'stopped';

interface Exchange {
  said: string;
  reply: string;
  source: 'server' | 'wall';
}

type LoggedOutcome = Extract<Outcome, 'in_range' | 'out_of_range' | 'not_covered'>;

type PassField = 'lineId' | 'recordCode' | 'checkPoint' | 'value' | 'unit' | 'verdict' | 'rule' | 'initials';

type Pass = Partial<Pick<LogReadingOutput, PassField>> & { outcome: LoggedOutcome };

export interface WallState {
  phase: WallPhase;
  startError: string | null;
  cook: string;
  exchange: Exchange | null;
  pass: Pass | null;
  openPrompt: OpenPrompt | null;
  inFlight: boolean;
  draft: string;
  notLogged: { reason: string } | null;
  pendingRetry: { words: string; requestId: string; initials: string } | null;
  stopMessage: string | null;
  roster: readonly string[];
  announcement: string;
  announcementSeq: number;
}

export type WallEvent =
  | { type: 'cookSelected'; initials: string }
  | { type: 'callFailed'; said: string; reason: string; requestId: string; initials: string }
  | { type: 'kitchenReplaced'; said: string }
  | { type: 'stopped'; message: string }
  | { type: 'edited'; text: string }
  | { type: 'localReplied'; said: string; reply: string }
  | { type: 'starting' }
  | { type: 'started' }
  | { type: 'startFailed'; error: string }
  | { type: 'sent'; said: string }
  | { type: 'resultReceived'; said: string; result: ToolCallResult };

const LOGGED: ReadonlySet<string> = new Set<LoggedOutcome>(['in_range', 'out_of_range', 'not_covered']);
const ANNOUNCED: ReadonlySet<string> = new Set<Outcome>(['in_range', 'out_of_range', 'not_covered', 'refused']);

export function initialWallState(profile: KitchenProfile): WallState {
  return {
    phase: 'starting',
    startError: null,
    cook: profile.roster[0],
    exchange: null,
    pass: null,
    openPrompt: null,
    inFlight: false,
    draft: '',
    notLogged: null,
    pendingRetry: null,
    stopMessage: null,
    roster: profile.roster,
    announcement: '',
    announcementSeq: 0,
  };
}

export function statusWrites(events: readonly WallEvent[], initial: WallState): number {
  return events.reduce(wallReducer, initial).announcementSeq - initial.announcementSeq;
}

// Every chip and the send button follow this, so nothing can be sent before tools/list has answered or
// while the one call allowed is still out.
export function controlsEnabled(state: WallState): boolean {
  return state.phase === 'ready' && !state.inFlight;
}

// Only a logged line moves the pass, and only with the fields the server sent: the page never
// compares a value with a limit itself, so a refusal or a held reading can never read as logged.
function passFrom(structured: Partial<LogReadingOutput> | undefined, previous: Pass | null): Pass | null {
  if (structured?.outcome === undefined || !LOGGED.has(structured.outcome)) return previous;
  const { outcome, lineId, recordCode, checkPoint, value, unit, verdict, rule, initials } = structured;
  return { outcome: outcome as LoggedOutcome, lineId, recordCode, checkPoint, value, unit, verdict, rule, initials };
}

// The status region's only writer. The sequence number moves on every record event, so a screen
// reader hears a second reading even when its sentence matches the one before.
function announced(state: WallState, outcome: Outcome | undefined, reply: string): Pick<WallState, 'announcement' | 'announcementSeq'> {
  if (outcome === undefined || !ANNOUNCED.has(outcome)) return { announcement: state.announcement, announcementSeq: state.announcementSeq };
  return { announcement: reply, announcementSeq: state.announcementSeq + 1 };
}

function afterResult(state: WallState, said: string, result: ToolCallResult): WallState {
  const structured = result.structuredContent as Partial<LogReadingOutput> | undefined;
  const reply = result.content[0]?.text ?? '';
  return {
    ...state,
    ...announced(state, structured?.outcome, reply),
    inFlight: false,
    draft: '',
    exchange: { said, reply, source: 'server' },
    pass: passFrom(structured, state.pass),
    openPrompt: structured?.prompt ?? null,
    notLogged: null,
    pendingRetry: null,
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
      return state.inFlight ? state : { ...state, inFlight: true };
    case 'resultReceived':
      return afterResult(state, event.said, event.result);
    case 'edited':
      return { ...state, draft: event.text };
    case 'localReplied':
      return { ...state, draft: '', exchange: { said: event.said, reply: event.reply, source: 'wall' } };
    // Never touches the pass: a call that did not land must not look logged.
    case 'callFailed':
      return {
        ...state,
        inFlight: false,
        draft: event.said,
        notLogged: { reason: event.reason },
        pendingRetry: { words: event.said, requestId: event.requestId, initials: event.initials },
      };
    case 'kitchenReplaced':
      return {
        ...state,
        inFlight: false,
        draft: event.said,
        exchange: { said: event.said, reply: NEW_KITCHEN_SENTENCE, source: 'wall' },
        notLogged: null,
        pendingRetry: null,
        openPrompt: null,
      };
    case 'stopped':
      return { ...state, phase: 'stopped', stopMessage: event.message, inFlight: false };
    case 'cookSelected':
      return state.roster.includes(event.initials) ? { ...state, cook: event.initials } : state;
  }
}

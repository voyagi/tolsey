import type { ToolCallResult } from '../client/mcp-client';
import type { DueNowOutput } from '../contract/due-now';
import type { LogReadingOutput, Outcome } from '../contract/log-reading';
import type { KitchenProfile } from '../domain/rule';
import type { OpenPrompt } from './intent';
import { NEW_KITCHEN_SENTENCE, NOT_LOGGED } from './wall-copy';

type WallPhase = 'starting' | 'ready' | 'start_failed' | 'stopped';

// The cook is the one who said the words, taken when they were sent: the roster can move on while
// the call is out, and the words stay theirs.
interface Exchange {
  said: string;
  reply: string;
  source: 'server' | 'wall';
  cook: string;
}

type LoggedOutcome = Extract<Outcome, 'in_range' | 'out_of_range' | 'not_covered'>;

type PassField = 'lineId' | 'recordCode' | 'checkPoint' | 'value' | 'unit' | 'verdict' | 'rule' | 'initials';

type Pass = Partial<Pick<LogReadingOutput, PassField>> & { outcome: LoggedOutcome };

type OpenCheck = DueNowOutput['openChecks'][number];

// A call that did not land and the request_id it went out under: the server may have stored it before
// the answer was lost, so the same call keeps that id until an answer for it comes back. `callKey` is
// the call as the server knows it (wall-session.ts builds it from every argument but request_id); the
// words are kept for the field.
interface PendingRetry {
  words: string;
  requestId: string;
  callKey: string;
}

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
  // Newest last. NOT LOGGED, when shown, always describes the newest: every event that clears or
  // shortens this list also clears the notice.
  pendingRetries: readonly PendingRetry[];
  stopMessage: string | null;
  roster: readonly string[];
  announcement: string;
  announcementSeq: number;
  openChecks: readonly OpenCheck[] | null;
}

export type WallEvent =
  | { type: 'openChecksLoaded'; openChecks: readonly OpenCheck[] }
  | { type: 'cookSelected'; initials: string }
  | { type: 'callFailed'; said: string; reason: string; requestId: string; initials: string; callKey: string }
  | { type: 'kitchenReplaced'; said: string; initials: string }
  | { type: 'stopped'; message: string }
  | { type: 'edited'; text: string }
  | { type: 'localReplied'; said: string; reply: string; initials: string }
  | { type: 'starting' }
  | { type: 'started' }
  | { type: 'startFailed'; error: string }
  | { type: 'sent'; said: string }
  | { type: 'resultReceived'; said: string; result: ToolCallResult; initials: string; callKey: string };

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
    draft: '',
    notLogged: null,
    pendingRetries: [],
    stopMessage: null,
    roster: profile.roster,
    announcement: '',
    announcementSeq: 0,
    openChecks: null,
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

// The status region's only writer, called once for each answer to a send: focus stays on the chip or
// the field the cook used, so nothing else tells a screen reader what came back, a question included.
// A list refresh, a theme change, a cook switch and an edit are not answers and never call it. The
// sequence number moves on every answer, so a screen reader hears a second one even when its sentence
// matches the one before.
function spoken(state: WallState, sentence: string): Pick<WallState, 'announcement' | 'announcementSeq'> {
  if (sentence === '') return { announcement: state.announcement, announcementSeq: state.announcementSeq };
  return { announcement: sentence, announcementSeq: state.announcementSeq + 1 };
}

export function retryFor(retries: readonly PendingRetry[], callKey: string): PendingRetry | undefined {
  return retries.find((retry) => retry.callKey === callKey);
}

function withoutRetry(retries: readonly PendingRetry[], callKey: string): readonly PendingRetry[] {
  return retries.filter((retry) => retry.callKey !== callKey);
}

// Only an answer for the same call settles its retry: an answer for another call, the same words under
// another question or from another cook included, says nothing about whether this one was stored.
function afterResult(state: WallState, said: string, result: ToolCallResult, initials: string, callKey: string): WallState {
  const structured = result.structuredContent as Partial<LogReadingOutput> | undefined;
  const reply = result.content[0]?.text ?? '';
  return {
    ...state,
    ...spoken(state, reply),
    inFlight: false,
    draft: '',
    exchange: { said, reply, source: 'server', cook: initials },
    pass: passFrom(structured, state.pass),
    openPrompt: structured?.prompt ?? null,
    notLogged: null,
    pendingRetries: withoutRetry(state.pendingRetries, callKey),
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
      return afterResult(state, event.said, event.result, event.initials, event.callKey);
    // In this case and the next, the field moves on to other words, so NOT LOGGED no longer describes it.
    // The pending retries stay: the words that did not land may still be stored, and resending them must
    // reuse their request_id.
    case 'edited':
      return { ...state, draft: event.text, notLogged: event.text === state.pendingRetries.at(-1)?.words ? state.notLogged : null };
    case 'localReplied':
      return {
        ...state,
        ...spoken(state, event.reply),
        draft: '',
        exchange: { said: event.said, reply: event.reply, source: 'wall', cook: event.initials },
        notLogged: null,
      };
    // Never touches the pass: a call that did not land must not look logged.
    case 'callFailed':
      return {
        ...state,
        ...spoken(state, `${NOT_LOGGED}. ${event.reason}`),
        inFlight: false,
        draft: event.said,
        notLogged: { reason: event.reason },
        pendingRetries: [
          ...withoutRetry(state.pendingRetries, event.callKey),
          { words: event.said, requestId: event.requestId, callKey: event.callKey },
        ],
      };
    // The open checks belonged to the kitchen that closed, so they go with it: the new kitchen's list
    // shows only once its own record answers.
    case 'kitchenReplaced':
      return {
        ...state,
        ...spoken(state, NEW_KITCHEN_SENTENCE),
        inFlight: false,
        draft: event.said,
        exchange: { said: event.said, reply: NEW_KITCHEN_SENTENCE, source: 'wall', cook: event.initials },
        notLogged: null,
        pendingRetries: [],
        openPrompt: null,
        openChecks: null,
      };
    // A stopped wall refuses every send, so a notice to send the words again, and the ids to send them
    // under, go with it.
    case 'stopped':
      return {
        ...state,
        ...spoken(state, event.message),
        phase: 'stopped',
        stopMessage: event.message,
        inFlight: false,
        notLogged: null,
        pendingRetries: [],
      };
    case 'cookSelected':
      return state.roster.includes(event.initials) ? { ...state, cook: event.initials } : state;
    // A list refresh is not an answer to a send, so it never writes the status region.
    case 'openChecksLoaded':
      return { ...state, openChecks: event.openChecks };
  }
}

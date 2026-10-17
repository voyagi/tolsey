import {
  McpClientError,
  mintKitchen,
  openMcpSession,
  type ClientOptions,
  type FetchLike,
  type McpSession,
  type ToolCallResult,
} from '../client/mcp-client';
import type { DueNowOutput } from '../contract/due-now';
import type { KitchenProfile } from '../domain/rule';
import { intentFor } from './intent';
import { DEMO_FULL_MESSAGE, failedAnswerReason, NO_ANSWER_REASON, STOPPED_MESSAGE, UNREACHED_REASON } from './wall-copy';
import { initialWallState, wallReducer, type WallEvent, type WallState } from './wall-state';

export interface WallSessionOptions {
  baseUrl: URL;
  profile: KitchenProfile;
  fetch?: FetchLike;
  newId?: () => string;
  timeoutMs?: number;
}

export interface WallSession {
  readonly kitchenId: string | null;
  readonly protocolVersion: string | null;
  readonly toolNames: readonly string[];
  start(): Promise<void>;
  retryStart(): Promise<void>;
  say(text: string): Promise<void>;
  edit(text: string): void;
  selectCook(initials: string): void;
  getState(): WallState;
  subscribe(listener: () => void): () => void;
}

const LOG_READING = 'log_reading';
const DUE_NOW = 'due_now';
const DEMO_FULL = 'demo_full';
const KITCHEN_GONE_STATUS = 404;
const KITCHEN_ENDED: ReadonlySet<unknown> = new Set(['kitchen_closed', 'kitchen_full']);
const SCREEN_ID_PREFIX = 'wall-';
const SCREEN_ID_UNSAFE = /[^A-Za-z0-9-]/g;
const SCREEN_ID_MAX_CHARS = 63;

// A start that failed, already worded for the wall with the step that failed.
class StartFailure extends Error {}

// The day's demo budget is spent, so nothing the wall could send today would land.
class DemoFull extends Error {}

type CallOutcome =
  | { kind: 'landed'; result: ToolCallResult }
  | { kind: 'failed'; reason: string }
  | { kind: 'kitchen_ended' }
  | { kind: 'demo_full' };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function detailOf(error: unknown): string {
  if (!(error instanceof McpClientError)) return 'unexpected error';
  return error.status === undefined ? error.kind : `status ${error.status}`;
}

async function attempt<T>(failedStep: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof McpClientError && error.code === DEMO_FULL) throw new DemoFull();
    throw new StartFailure(`${failedStep} (${detailOf(error)}).`);
  }
}

// A refusal is never shown as logged: only a result without isError reaches the reducer as one.
function refusalOutcome(result: ToolCallResult): CallOutcome {
  const code = result._meta?.error;
  if (code === DEMO_FULL) return { kind: 'demo_full' };
  if (KITCHEN_ENDED.has(code)) return { kind: 'kitchen_ended' };
  return { kind: 'failed', reason: result.content[0]?.text || failedAnswerReason(undefined) };
}

function failureOutcome(error: unknown): CallOutcome {
  if (!(error instanceof McpClientError)) return { kind: 'failed', reason: failedAnswerReason(undefined) };
  if (error.status === KITCHEN_GONE_STATUS) return { kind: 'kitchen_ended' };
  if (error.kind === 'timeout') return { kind: 'failed', reason: NO_ANSWER_REASON };
  if (error.kind === 'network') return { kind: 'failed', reason: UNREACHED_REASON };
  return { kind: 'failed', reason: failedAnswerReason(error.status) };
}

type OpenCheck = DueNowOutput['openChecks'][number];

function isOpenCheck(entry: unknown): entry is OpenCheck {
  if (typeof entry !== 'object' || entry === null) return false;
  const { id, name } = entry as Record<string, unknown>;
  return typeof id === 'string' && typeof name === 'string';
}

// The list is shown only as the record gave it: an error, a failed call or a malformed answer gives
// null, and the page then keeps the list it had for this kitchen (none after a replacement) rather
// than guessing one.
async function fetchOpenChecks(session: McpSession): Promise<OpenCheck[] | null> {
  try {
    const result = await session.callTool(DUE_NOW, {});
    const list = result.isError === true ? undefined : result.structuredContent?.openChecks;
    if (!Array.isArray(list) || !list.every(isOpenCheck)) return null;
    return list.map(({ id, name }) => ({ id, name }));
  } catch {
    return null;
  }
}

async function callLogReading(session: McpSession, args: Record<string, unknown>): Promise<CallOutcome> {
  try {
    const result = await session.callTool(LOG_READING, args);
    return result.isError === true ? refusalOutcome(result) : { kind: 'landed', result };
  } catch (error) {
    return failureOutcome(error);
  }
}

export function createWallSession(options: WallSessionOptions): WallSession {
  const { baseUrl, profile, fetch: fetchFn } = options;
  const clientOptions: ClientOptions = { timeoutMs: options.timeoutMs };
  const newId = options.newId ?? (() => crypto.randomUUID());
  const screenId = `${SCREEN_ID_PREFIX}${newId()}`.replace(SCREEN_ID_UNSAFE, '').slice(0, SCREEN_ID_MAX_CHARS);
  const listeners = new Set<() => void>();
  let state = initialWallState(profile);
  let mcp: McpSession | null = null;
  let kitchenId: string | null = null;
  let toolNames: readonly string[] = [];
  // One new kitchen per kitchen that has taken a call: without it a kitchen that closes at once
  // would be replaced again and again.
  let replacementUsed = false;
  let refreshCount = 0;

  function dispatch(event: WallEvent): void {
    state = wallReducer(state, event);
    for (const listener of listeners) listener();
  }

  function stop(message: string): void {
    mcp = null;
    dispatch({ type: 'stopped', message });
  }

  async function connect(): Promise<void> {
    const minted = await attempt('Could not create a kitchen', () => mintKitchen(baseUrl, fetchFn, {}, clientOptions));
    kitchenId = minted.id;
    const session = await attempt('Could not open the MCP session', () =>
      openMcpSession(new URL(minted.mcpPath, baseUrl), fetchFn, clientOptions),
    );
    toolNames = (await attempt('Could not open the MCP session', () => session.listTools())).map((tool) => tool.name);
    if (!toolNames.includes(LOG_READING)) {
      throw new StartFailure(`The server does not list ${LOG_READING}, so the wall cannot log a reading.`);
    }
    mcp = session;
  }

  // Runs after the event it follows has been dispatched, so the reply and the pass never wait on the
  // list. Only the newest refresh may set it, and only while its session is still the wall's: a list
  // answered late for an earlier call, or for a kitchen since replaced, is dropped.
  async function refreshOpenChecks(): Promise<void> {
    const session = mcp;
    if (session === null || !toolNames.includes(DUE_NOW)) return;
    refreshCount += 1;
    const refresh = refreshCount;
    const openChecks = await fetchOpenChecks(session);
    if (openChecks === null || refresh !== refreshCount || mcp !== session) return;
    dispatch({ type: 'openChecksLoaded', openChecks });
  }

  async function start(): Promise<void> {
    dispatch({ type: 'starting' });
    mcp = null;
    try {
      await connect();
      dispatch({ type: 'started' });
      await refreshOpenChecks();
    } catch (error) {
      if (error instanceof DemoFull) {
        stop(DEMO_FULL_MESSAGE);
        return;
      }
      dispatch({ type: 'startFailed', error: error instanceof StartFailure ? error.message : messageOf(error) });
    }
  }

  // A kitchen minted before a failed initialize is left to expire: minting again is simpler, and the
  // daily budget bounds it.
  async function retryStart(): Promise<void> {
    if (state.phase !== 'start_failed') return;
    await start();
  }

  async function replaceKitchen(said: string): Promise<void> {
    mcp = null;
    if (replacementUsed) {
      stop(STOPPED_MESSAGE);
      return;
    }
    replacementUsed = true;
    try {
      await connect();
      dispatch({ type: 'kitchenReplaced', said });
    } catch (error) {
      stop(error instanceof DemoFull ? DEMO_FULL_MESSAGE : STOPPED_MESSAGE);
      return;
    }
    // The reducer dropped the closed kitchen's list; the new kitchen's record fills it.
    await refreshOpenChecks();
  }

  // Unchanged words from the same cook after a call that did not land keep their request_id, so a
  // call the server stored before its answer was lost is answered from the record, never stored twice.
  function requestIdFor(text: string, initials: string): string {
    const retry = state.pendingRetry;
    return retry !== null && retry.words === text && retry.initials === initials ? retry.requestId : newId();
  }

  // One call in flight at a time: a second say while the first is out sends nothing.
  async function say(text: string): Promise<void> {
    const session = mcp;
    if (session === null || state.phase !== 'ready' || state.inFlight) return;
    const intent = intentFor(text, profile, state.openPrompt);
    if (intent.kind === 'none') return;
    if (intent.kind === 'local_reply') {
      dispatch({ type: 'localReplied', said: text, reply: intent.text });
      return;
    }
    const initials = state.cook;
    const requestId = requestIdFor(text, initials);
    dispatch({ type: 'edited', text });
    dispatch({ type: 'sent', said: text });
    const outcome = await callLogReading(session, { ...intent.args, initials, screen_id: screenId, request_id: requestId });
    switch (outcome.kind) {
      case 'landed':
        replacementUsed = false;
        dispatch({ type: 'resultReceived', said: text, result: outcome.result });
        await refreshOpenChecks();
        return;
      case 'failed':
        dispatch({ type: 'callFailed', said: text, reason: outcome.reason, requestId, initials });
        return;
      case 'kitchen_ended':
        await replaceKitchen(text);
        return;
      case 'demo_full':
        stop(DEMO_FULL_MESSAGE);
        return;
    }
  }

  return {
    get kitchenId() {
      return kitchenId;
    },
    get protocolVersion() {
      return mcp?.protocolVersion ?? null;
    },
    get toolNames() {
      return toolNames;
    },
    start,
    retryStart,
    say,
    edit: (text) => dispatch({ type: 'edited', text }),
    selectCook: (initials) => dispatch({ type: 'cookSelected', initials }),
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

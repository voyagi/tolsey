import { McpClientError, mintKitchen, openMcpSession, type FetchLike, type McpSession } from '../client/mcp-client';
import type { KitchenProfile } from '../domain/rule';
import { intentFor } from './intent';
import { initialWallState, wallReducer, type WallEvent, type WallState } from './wall-state';

export interface WallSessionOptions {
  baseUrl: URL;
  profile: KitchenProfile;
  fetch?: FetchLike;
  newId?: () => string;
}

export interface WallSession {
  readonly kitchenId: string | null;
  readonly protocolVersion: string | null;
  readonly toolNames: readonly string[];
  start(): Promise<void>;
  retryStart(): Promise<void>;
  say(text: string): Promise<void>;
  edit(text: string): void;
  getState(): WallState;
  subscribe(listener: () => void): () => void;
}

const LOG_READING = 'log_reading';
const SCREEN_ID_PREFIX = 'wall-';
const SCREEN_ID_UNSAFE = /[^A-Za-z0-9-]/g;
const SCREEN_ID_MAX_CHARS = 63;

// A start that failed, already worded for the wall with the step that failed.
class StartFailure extends Error {}

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
    throw new StartFailure(`${failedStep} (${detailOf(error)}).`);
  }
}

export function createWallSession(options: WallSessionOptions): WallSession {
  const { baseUrl, profile, fetch: fetchFn } = options;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const screenId = `${SCREEN_ID_PREFIX}${newId()}`.replace(SCREEN_ID_UNSAFE, '').slice(0, SCREEN_ID_MAX_CHARS);
  const listeners = new Set<() => void>();
  let state = initialWallState(profile);
  let mcp: McpSession | null = null;
  let kitchenId: string | null = null;
  let toolNames: readonly string[] = [];

  function dispatch(event: WallEvent): void {
    state = wallReducer(state, event);
    for (const listener of listeners) listener();
  }

  async function start(): Promise<void> {
    dispatch({ type: 'starting' });
    mcp = null;
    try {
      const minted = await attempt('Could not create a kitchen', () => mintKitchen(baseUrl, fetchFn, {}));
      kitchenId = minted.id;
      const session = await attempt('Could not open the MCP session', () =>
        openMcpSession(new URL(minted.mcpPath, baseUrl), fetchFn),
      );
      toolNames = (await attempt('Could not open the MCP session', () => session.listTools())).map((tool) => tool.name);
      if (!toolNames.includes(LOG_READING)) {
        throw new StartFailure(`The server does not list ${LOG_READING}, so the wall cannot log a reading.`);
      }
      mcp = session;
      dispatch({ type: 'started' });
    } catch (error) {
      dispatch({ type: 'startFailed', error: error instanceof StartFailure ? error.message : messageOf(error) });
    }
  }

  // A kitchen minted before a failed initialize is left to expire: minting again is simpler, and the
  // daily budget bounds it.
  async function retryStart(): Promise<void> {
    if (state.phase !== 'start_failed') return;
    await start();
  }

  // One call in flight at a time: a second say while the first is out sends nothing.
  async function say(text: string): Promise<void> {
    if (mcp === null || state.inFlight) return;
    const intent = intentFor(text, profile, state.openPrompt);
    if (intent.kind === 'none') return;
    if (intent.kind === 'local_reply') {
      dispatch({ type: 'localReplied', said: text, reply: intent.text });
      return;
    }
    const args = { ...intent.args, initials: state.cook, screen_id: screenId, request_id: newId() };
    dispatch({ type: 'edited', text });
    dispatch({ type: 'sent', said: text });
    try {
      dispatch({ type: 'resultReceived', said: text, result: await mcp.callTool(LOG_READING, args) });
    } catch (error) {
      dispatch({ type: 'wallReplied', said: text, reply: messageOf(error) });
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
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

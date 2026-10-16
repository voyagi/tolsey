import { mintKitchen, openMcpSession, type FetchLike, type McpSession } from '../client/mcp-client';
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
  say(text: string): Promise<void>;
  getState(): WallState;
  subscribe(listener: () => void): () => void;
}

const LOG_READING = 'log_reading';
const SCREEN_ID_PREFIX = 'wall-';
const SCREEN_ID_UNSAFE = /[^A-Za-z0-9-]/g;
const SCREEN_ID_MAX_CHARS = 63;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    try {
      const minted = await mintKitchen(baseUrl, fetchFn, {});
      kitchenId = minted.id;
      const session = await openMcpSession(new URL(minted.mcpPath, baseUrl), fetchFn);
      toolNames = (await session.listTools()).map((tool) => tool.name);
      if (!toolNames.includes(LOG_READING)) {
        dispatch({ type: 'startFailed', error: `The server lists no ${LOG_READING} tool, so the wall cannot log a reading.` });
        return;
      }
      mcp = session;
      dispatch({ type: 'started' });
    } catch (error) {
      dispatch({ type: 'startFailed', error: messageOf(error) });
    }
  }

  // One call in flight at a time: a second say while the first is out sends nothing.
  async function say(text: string): Promise<void> {
    if (mcp === null || state.inFlight) return;
    const intent = intentFor(text, profile, state.openPrompt);
    if (intent.kind === 'none') return;
    if (intent.kind === 'local_reply') {
      dispatch({ type: 'wallReplied', said: text, reply: intent.text });
      return;
    }
    const args = { ...intent.args, initials: state.cook, screen_id: screenId, request_id: newId() };
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
    say,
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

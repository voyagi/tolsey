import type { KitchenProfile } from '../domain/rule';

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface WallSessionOptions {
  baseUrl: URL;
  profile: KitchenProfile;
  fetch?: FetchLike;
  newId?: () => string;
}

export interface WallSessionState {
  phase: 'starting' | 'ready' | 'start_failed' | 'stopped';
  pass: Record<string, unknown> | null;
}

export interface WallSession {
  readonly kitchenId: string | null;
  readonly protocolVersion: string | null;
  readonly toolNames: readonly string[];
  start(): Promise<void>;
  say(text: string): Promise<void>;
  getState(): WallSessionState;
  subscribe(listener: () => void): () => void;
}

export function createWallSession(_options: WallSessionOptions): WallSession {
  const state: WallSessionState = { phase: 'starting', pass: null };
  return {
    kitchenId: null,
    protocolVersion: null,
    toolNames: [],
    start: async () => {},
    say: async () => {},
    getState: () => state,
    subscribe: () => () => {},
  };
}

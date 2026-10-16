import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../client/mcp-client';
import { WALL_PROFILE } from './profile';
import { createWallSession } from './wall-session';
import { controlsEnabled } from './wall-state';

const BASE = new URL('http://wall.test/');
const MINTED = {
  id: '0123456789abcdef0123456789abcdef',
  mcpPath: '/mcp/k/0123456789abcdef0123456789abcdef',
  expiresAt: '2026-10-17T10:00:00.000Z',
  closesAt: '2026-10-17T08:43:00.000Z',
};
const IN_RANGE = {
  content: [{ type: 'text', text: 'Walk-in, 38, in range, AB' }],
  structuredContent: { outcome: 'in_range', verdict: 'in range', value: 38 },
};

interface RpcBody {
  id?: number;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

type Route = (body: RpcBody) => Response | Promise<Response>;

interface Routes {
  mint: () => Response;
  initialize: Route;
  toolsList: Route;
  toolsCall: Route;
}

function asJson(message: unknown, status = 200): Response {
  return new Response(JSON.stringify(message), { status, headers: { 'content-type': 'application/json' } });
}

function answer(body: RpcBody, result: unknown): Response {
  return asJson({ jsonrpc: '2.0', id: body.id, result });
}

const WORKING: Routes = {
  mint: () => asJson(MINTED, 201),
  initialize: (body) => answer(body, { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'tolsey', version: '0.1.0' } }),
  toolsList: (body) => answer(body, { tools: [{ name: 'log_reading' }] }),
  toolsCall: (body) => answer(body, IN_RANGE),
};

// A Worker stand-in routed by path and JSON-RPC method, with each route swappable mid-test and every
// request recorded, so a test can hold one answer back or count what was sent.
function fakeWorker(overrides: Partial<Routes> = {}) {
  const routes: Routes = { ...WORKING, ...overrides };
  const sent: { path: string; body: RpcBody | undefined }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as RpcBody) : undefined;
    sent.push({ path, body });
    if (path === '/api/kitchens') return routes.mint();
    switch (body?.method) {
      case 'initialize':
        return routes.initialize(body);
      case 'notifications/initialized':
        return new Response(null, { status: 202 });
      case 'tools/list':
        return routes.toolsList(body);
      case 'tools/call':
        return routes.toolsCall(body);
      default:
        throw new Error(`the fake Worker has no route for ${path} ${String(body?.method)}`);
    }
  };
  const callsOf = (method: string) => sent.filter((request) => request.body?.method === method);
  return { routes, fetchFn, sent, callsOf };
}

function heldBack<T>() {
  let release: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function counterIds(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `id-${next}`;
  };
}

// Lets the session's awaited fetches run until the held-back route is reached.
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

describe('the controls wait for tools/list', () => {
  it.fails('controlsEnabled is false before tools/list answers and true after', async () => {
    const list = heldBack<Response>();
    const worker = fakeWorker({ toolsList: () => list.promise });
    const session = createWallSession({ baseUrl: BASE, profile: WALL_PROFILE, fetch: worker.fetchFn });
    const started = session.start();
    await settle();
    expect(worker.callsOf('tools/list')).toHaveLength(1);
    expect(controlsEnabled(session.getState())).toBe(false);
    list.release(answer({ id: worker.callsOf('tools/list')[0].body?.id }, { tools: [{ name: 'log_reading' }] }));
    await started;
    expect(controlsEnabled(session.getState())).toBe(true);
  });
});

describe('a failed start names its step and can be retried', () => {
  it.fails('a mint that succeeds with an initialize answered 500 is start_failed naming the MCP session, and retryStart reaches ready', async () => {
    const worker = fakeWorker({ initialize: () => asJson({ error: 'internal' }, 500) });
    const session = createWallSession({ baseUrl: BASE, profile: WALL_PROFILE, fetch: worker.fetchFn });
    await session.start();
    expect(session.getState().phase).toBe('start_failed');
    expect(session.getState().startError).toMatch(/could not open the MCP session/i);
    expect(session.getState().startError).toContain('500');

    worker.routes.initialize = WORKING.initialize;
    await session.retryStart();
    expect(session.getState().phase).toBe('ready');
    expect(session.getState().startError).toBeNull();
    expect(worker.sent.filter((request) => request.path === '/api/kitchens')).toHaveLength(2);
  });

  it.fails('a refused mint is start_failed naming the kitchen and the status', async () => {
    const worker = fakeWorker({ mint: () => asJson({ error: 'demo_full' }, 503) });
    const session = createWallSession({ baseUrl: BASE, profile: WALL_PROFILE, fetch: worker.fetchFn });
    await session.start();
    expect(session.getState().startError).toMatch(/could not create a kitchen/i);
    expect(session.getState().startError).toContain('503');
  });

  it.fails('a tools list without log_reading is start_failed saying so', async () => {
    const worker = fakeWorker({ toolsList: (body) => answer(body, { tools: [{ name: 'due_now' }] }) });
    const session = createWallSession({ baseUrl: BASE, profile: WALL_PROFILE, fetch: worker.fetchFn });
    await session.start();
    expect(session.getState().phase).toBe('start_failed');
    expect(session.getState().startError).toMatch(/does not list log_reading/i);
  });
});

describe('one call in flight', () => {
  it('a say while a call is in flight sends no second tools/call', async () => {
    const call = heldBack<Response>();
    const worker = fakeWorker({ toolsCall: () => call.promise });
    const session = createWallSession({ baseUrl: BASE, profile: WALL_PROFILE, fetch: worker.fetchFn });
    await session.start();
    const first = session.say('the walk-in reads 38');
    await settle();
    await session.say('walk-in 15');
    expect(worker.callsOf('tools/call')).toHaveLength(1);
    call.release(answer({ id: worker.callsOf('tools/call')[0].body?.id }, IN_RANGE));
    await first;
    expect(session.getState().exchange?.said).toBe('the walk-in reads 38');
  });

  it.fails('holds the sent words in the field while the call is out and clears them on the result', async () => {
    const call = heldBack<Response>();
    const worker = fakeWorker({ toolsCall: () => call.promise });
    const session = createWallSession({ baseUrl: BASE, profile: WALL_PROFILE, fetch: worker.fetchFn });
    await session.start();
    const said = session.say('reach-in two is fine');
    await settle();
    expect(session.getState().draft).toBe('reach-in two is fine');
    call.release(answer({ id: worker.callsOf('tools/call')[0].body?.id }, IN_RANGE));
    await said;
    expect(session.getState().draft).toBe('');
  });
});

describe('the log_reading arguments', () => {
  it('carry the cook as initials, one screen_id across calls and a new request_id per call', async () => {
    const worker = fakeWorker();
    const session = createWallSession({ baseUrl: BASE, profile: WALL_PROFILE, fetch: worker.fetchFn, newId: counterIds() });
    await session.start();
    await session.say('the walk-in reads 38');
    await session.say('walk-in 15');
    const [first, second] = worker.callsOf('tools/call').map((request) => request.body?.params?.arguments ?? {});
    expect(first.initials).toBe(session.getState().cook);
    expect(second.initials).toBe(session.getState().cook);
    expect(first.screen_id).toBe(second.screen_id);
    expect(first.request_id).not.toBe(second.request_id);
  });

  it('a phrase with nothing to log gets the local reply and sends no tools/call', async () => {
    const worker = fakeWorker();
    const session = createWallSession({ baseUrl: BASE, profile: WALL_PROFILE, fetch: worker.fetchFn });
    await session.start();
    await session.say('hello');
    expect(worker.callsOf('tools/call')).toHaveLength(0);
    expect(session.getState().exchange).toMatchObject({ said: 'hello', source: 'wall' });
  });

  it.fails('edit puts the typed words in the field', async () => {
    const session = createWallSession({ baseUrl: BASE, profile: WALL_PROFILE, fetch: fakeWorker().fetchFn });
    await session.start();
    session.edit('walk-in 4');
    expect(session.getState().draft).toBe('walk-in 4');
  });
});

import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../client/mcp-client';
import { WALL_PROFILE } from './profile';
import { createWallSession, type WallSession } from './wall-session';
import { DEMO_FULL_MESSAGE, NEW_KITCHEN_SENTENCE, STOPPED_MESSAGE } from './wall-copy';
import { controlsEnabled } from './wall-state';

const BASE = new URL('http://wall.test/');
const KITCHEN_IDS = ['0123456789abcdef0123456789abcdef', 'fedcba9876543210fedcba9876543210', 'aaaabbbbccccddddeeeeffff00001111'];
const MINTED = KITCHEN_IDS.map((id) => ({
  id,
  mcpPath: `/mcp/k/${id}`,
  expiresAt: '2026-10-17T10:00:00.000Z',
  closesAt: '2026-10-17T08:43:00.000Z',
}));
const IN_RANGE = {
  content: [{ type: 'text', text: 'Walk-in, 38, in range, AB' }],
  structuredContent: { outcome: 'in_range', verdict: 'in range', value: 38 },
};
const WALK_IN = 'the walk-in reads 38';
const EXPIRED_TEXT = 'Tolsey already logged this call earlier, record 261016-001. Use a new request_id only for a new reading.';
const SHORT_TIMEOUT_MS = 30;

interface RpcBody {
  id?: number;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

type Route = (body: RpcBody) => Response | Promise<Response>;

interface Routes {
  mint: (count: number) => Response | Promise<Response>;
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

function toolError(code: string, text: string, extra: Record<string, unknown> = {}): Route {
  return (body) => answer(body, { content: [{ type: 'text', text }], isError: true, _meta: { error: code }, ...extra });
}

const KITCHEN_GONE: Route = () => asJson({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Not found' } }, 404);
const KITCHEN_CLOSED = toolError('kitchen_closed', 'This kitchen has closed. Start a new kitchen to keep logging.');
const KITCHEN_FULL = toolError('kitchen_full', 'This kitchen is full. Start a new kitchen to keep logging.');
const NEVER_ANSWERS: Route = () => new Promise<Response>(() => undefined);

const WORKING: Routes = {
  mint: (count) => asJson(MINTED[count - 1], 201),
  initialize: (body) => answer(body, { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'tolsey', version: '0.1.0' } }),
  toolsList: (body) => answer(body, { tools: [{ name: 'log_reading' }] }),
  toolsCall: (body) => answer(body, IN_RANGE),
};

// Rejects as a browser fetch does once its signal aborts, so a route that never answers ends in the
// session's own timeout.
function honouringAbort(reply: Response | Promise<Response>, signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(reply).then(resolve, reject);
  });
}

// A Worker stand-in routed by path and JSON-RPC method, with each route swappable mid-test and every
// request recorded, so a test can hold one answer back or count what was sent.
function fakeWorker(overrides: Partial<Routes> = {}) {
  const routes: Routes = { ...WORKING, ...overrides };
  const sent: { path: string; body: RpcBody | undefined }[] = [];
  let mints = 0;
  const route = (path: string, body: RpcBody | undefined): Response | Promise<Response> => {
    if (path === '/api/kitchens') {
      mints += 1;
      return routes.mint(mints);
    }
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
  const fetchFn: FetchLike = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as RpcBody) : undefined;
    sent.push({ path, body });
    return honouringAbort(route(path, body), init?.signal);
  };
  const callsOf = (method: string) => sent.filter((request) => request.body?.method === method);
  const mintCount = () => sent.filter((request) => request.path === '/api/kitchens').length;
  const argsOfCall = (index: number) => callsOf('tools/call')[index]?.body?.params?.arguments ?? {};
  return { routes, fetchFn, sent, callsOf, mintCount, argsOfCall };
}

type Worker = ReturnType<typeof fakeWorker>;

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

// Lets the session's awaited fetches run until the held-back route is reached: one macrotask drains
// every pending promise turn, however many the fake's abort wrapper adds.
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function sessionOn(worker: Worker): WallSession {
  return createWallSession({ baseUrl: BASE, profile: WALL_PROFILE, fetch: worker.fetchFn, newId: counterIds(), timeoutMs: SHORT_TIMEOUT_MS });
}

// A started session that has already logged one walk-in line, so a test can see the pass stay put.
async function loggedOnce(worker: Worker): Promise<WallSession> {
  const session = sessionOn(worker);
  await session.start();
  await session.say(WALK_IN);
  expect(session.getState().pass).toMatchObject({ outcome: 'in_range', value: 38 });
  return session;
}

describe('the controls wait for tools/list', () => {
  it('controlsEnabled is false before tools/list answers and true after', async () => {
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
  it('a mint that succeeds with an initialize answered 500 is start_failed naming the MCP session, and retryStart reaches ready', async () => {
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
    expect(worker.mintCount()).toBe(2);
  });

  it('a refused mint is start_failed naming the kitchen and the status', async () => {
    const worker = fakeWorker({ mint: () => asJson({ error: 'allowlist_unconfigured' }, 503) });
    const session = createWallSession({ baseUrl: BASE, profile: WALL_PROFILE, fetch: worker.fetchFn });
    await session.start();
    expect(session.getState().startError).toMatch(/could not create a kitchen/i);
    expect(session.getState().startError).toContain('503');
  });

  it('a tools list without log_reading is start_failed saying so', async () => {
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
    const first = session.say(WALK_IN);
    await settle();
    await session.say('walk-in 15');
    expect(worker.callsOf('tools/call')).toHaveLength(1);
    call.release(answer({ id: worker.callsOf('tools/call')[0].body?.id }, IN_RANGE));
    await first;
    expect(session.getState().exchange?.said).toBe(WALK_IN);
  });

  it('holds the sent words in the field while the call is out and clears them on the result', async () => {
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
    await session.say(WALK_IN);
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

  it('edit puts the typed words in the field', async () => {
    const session = createWallSession({ baseUrl: BASE, profile: WALL_PROFILE, fetch: fakeWorker().fetchFn });
    await session.start();
    session.edit('walk-in 4');
    expect(session.getState().draft).toBe('walk-in 4');
  });
});

describe('who is logging', () => {
  const HELD = {
    content: [{ type: 'text', text: 'Say it one digit at a time. What does the walk-in read?' }],
    structuredContent: { outcome: 'held', verdict: 'held', value: 15, prompt: { kind: 'digit_repeat', id: 'prompt-1' } },
  };

  it('a switch from AB to MR puts MR on the next call', async () => {
    const worker = fakeWorker();
    const session = sessionOn(worker);
    await session.start();
    await session.say(WALK_IN);
    session.selectCook('MR');
    await session.say('the walk-in reads 37');
    expect(worker.argsOfCall(0).initials).toBe('AB');
    expect(worker.argsOfCall(1).initials).toBe('MR');
  });

  it('a switch while a call is in flight leaves that call with the cook it was sent with', async () => {
    const call = heldBack<Response>();
    const worker = fakeWorker({ toolsCall: () => call.promise });
    const session = createWallSession({ baseUrl: BASE, profile: WALL_PROFILE, fetch: worker.fetchFn });
    await session.start();
    const said = session.say(WALK_IN);
    await settle();
    session.selectCook('MR');
    call.release(answer({ id: worker.callsOf('tools/call')[0].body?.id }, IN_RANGE));
    await said;
    expect(worker.argsOfCall(0).initials).toBe('AB');
    expect(session.getState().cook).toBe('MR');
  });

  it.each<[string, Route]>([
    ['a logged reading', (body) => answer(body, IN_RANGE)],
    ['a closed kitchen that is replaced', KITCHEN_CLOSED],
  ])('after %s, the conversation names the cook who said the words, not one switched to while the call was out', async (_answer, route) => {
    const call = heldBack<Response>();
    const worker = fakeWorker({ toolsCall: () => call.promise });
    const session = createWallSession({ baseUrl: BASE, profile: WALL_PROFILE, fetch: worker.fetchFn });
    await session.start();
    const said = session.say(WALK_IN);
    await settle();
    session.selectCook('MR');
    call.release(await route({ id: worker.callsOf('tools/call')[0].body?.id }));
    await said;
    expect(session.getState().cook).toBe('MR');
    expect(session.getState().exchange).toMatchObject({ said: WALK_IN, cook: 'AB' });
  });

  it('a switch after a held question applies to the answer call', async () => {
    const worker = fakeWorker({ toolsCall: (body) => answer(body, HELD) });
    const session = sessionOn(worker);
    await session.start();
    await session.say('walk-in 15');
    worker.routes.toolsCall = WORKING.toolsCall;
    session.selectCook('MR');
    await session.say('1 5');
    expect(worker.argsOfCall(1)).toMatchObject({ initials: 'MR', pending_prompt_id: 'prompt-1', value: 15 });
  });

  it('a cook not on the roster is ignored, so the next call still carries a roster cook', async () => {
    const worker = fakeWorker();
    const session = sessionOn(worker);
    await session.start();
    session.selectCook('ZZ');
    await session.say(WALK_IN);
    expect(worker.argsOfCall(0).initials).toBe('AB');
  });

  it('a retry of the same words after a cook switch is a new call with a new request_id', async () => {
    const worker = fakeWorker({ toolsCall: NEVER_ANSWERS });
    const session = sessionOn(worker);
    await session.start();
    await session.say(WALK_IN);
    worker.routes.toolsCall = WORKING.toolsCall;
    session.selectCook('MR');
    await session.say(WALK_IN);
    expect(worker.argsOfCall(1).request_id).not.toBe(worker.argsOfCall(0).request_id);
    expect(worker.argsOfCall(1).initials).toBe('MR');
  });
});

describe('a call that does not land shows NOT LOGGED, keeps the words and leaves the pass', () => {
  const failures: [string, Route][] = [
    ['a timeout', NEVER_ANSWERS],
    [
      'a network rejection',
      () => {
        throw new TypeError('Failed to fetch');
      },
    ],
    ['an HTTP 500', () => asJson({ error: 'internal' }, 500)],
    ['an empty body', () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['a body that is not JSON', () => new Response('<html>busy</html>', { status: 200, headers: { 'content-type': 'text/html' } })],
  ];

  it.each(failures)('%s', async (_failure, route) => {
    const worker = fakeWorker();
    const session = await loggedOnce(worker);
    const passBefore = session.getState().pass;
    worker.routes.toolsCall = route;

    await session.say('walk-in 45');

    const state = session.getState();
    expect(state.notLogged?.reason).toEqual(expect.any(String));
    expect(state.notLogged?.reason).not.toBe('');
    expect(state.draft).toBe('walk-in 45');
    expect(state.pass).toBe(passBefore);
    expect(state.inFlight).toBe(false);
    expect(state.phase).toBe('ready');
  });

  it('the reason for an HTTP 500 names the status and nothing of the body', async () => {
    const worker = fakeWorker();
    const session = await loggedOnce(worker);
    worker.routes.toolsCall = () => asJson({ error: 'internal', stack: 'at handler (worker.js:1)' }, 500);
    await session.say('walk-in 45');
    expect(session.getState().notLogged?.reason).toContain('status 500');
    expect(session.getState().notLogged?.reason).not.toContain('worker.js');
  });

  it('an isError result shows its own text as the reason and never moves the pass, whatever it carries', async () => {
    const worker = fakeWorker();
    const session = await loggedOnce(worker);
    const passBefore = session.getState().pass;
    const text = "Those initials are not on this kitchen's roster. Who is logging? Call again with the whole reading and their initials.";
    worker.routes.toolsCall = toolError('initials_not_on_roster', text, {
      structuredContent: { outcome: 'out_of_range', verdict: 'out of range', value: 45 },
    });

    await session.say('walk-in 45');

    expect(session.getState().notLogged).toEqual({ reason: text });
    expect(session.getState().pass).toBe(passBefore);
    expect(session.getState().draft).toBe('walk-in 45');
  });

  it('request_id_expired shows the server text and never a pass', async () => {
    const worker = fakeWorker({ toolsCall: toolError('request_id_expired', EXPIRED_TEXT) });
    const session = sessionOn(worker);
    await session.start();
    await session.say(WALK_IN);
    expect(session.getState().notLogged).toEqual({ reason: EXPIRED_TEXT });
    expect(session.getState().pass).toBeNull();
  });
});

describe('a retry of the same words reuses the request_id', () => {
  it('the same words right after a timeout resend the same request_id, and a later new reading gets a new one', async () => {
    const worker = fakeWorker({ toolsCall: NEVER_ANSWERS });
    const session = sessionOn(worker);
    await session.start();
    await session.say(WALK_IN);
    expect(session.getState().notLogged).not.toBeNull();

    worker.routes.toolsCall = WORKING.toolsCall;
    await session.say(WALK_IN);
    expect(worker.argsOfCall(1).request_id).toBe(worker.argsOfCall(0).request_id);
    expect(session.getState().notLogged).toBeNull();
    expect(session.getState().pendingRetry).toBeNull();

    await session.say(WALK_IN);
    expect(worker.argsOfCall(2).request_id).not.toBe(worker.argsOfCall(1).request_id);
  });

  it('a local reply after a NOT LOGGED clears the notice, and the same words sent after it still reuse the request_id', async () => {
    const worker = fakeWorker({ toolsCall: NEVER_ANSWERS });
    const session = sessionOn(worker);
    await session.start();
    await session.say(WALK_IN);
    expect(session.getState().notLogged).not.toBeNull();

    await session.say('hello');
    expect(session.getState().exchange?.source).toBe('wall');
    expect(session.getState().notLogged).toBeNull();

    worker.routes.toolsCall = WORKING.toolsCall;
    await session.say(WALK_IN);
    expect(worker.argsOfCall(1).request_id).toBe(worker.argsOfCall(0).request_id);
  });

  it('edited words after a NOT LOGGED are a new utterance with a new request_id', async () => {
    const worker = fakeWorker({ toolsCall: NEVER_ANSWERS });
    const session = sessionOn(worker);
    await session.start();
    await session.say(WALK_IN);
    worker.routes.toolsCall = WORKING.toolsCall;
    await session.say('the walk-in reads 37');
    expect(worker.argsOfCall(1).request_id).not.toBe(worker.argsOfCall(0).request_id);
  });
});

describe('a gone or closed kitchen is replaced once', () => {
  it.each<[string, Route]>([
    ['a 404 at the kitchen path', KITCHEN_GONE],
    ['kitchen_closed', KITCHEN_CLOSED],
    ['kitchen_full', KITCHEN_FULL],
  ])('%s mints one new kitchen, says so, keeps the words, and the next say goes to the new kitchen with a new request_id', async (_cause, route) => {
    const worker = fakeWorker();
    const session = await loggedOnce(worker);
    worker.routes.toolsCall = route;

    await session.say('walk-in 45');

    expect(worker.mintCount()).toBe(2);
    expect(session.kitchenId).toBe(KITCHEN_IDS[1]);
    expect(session.getState().phase).toBe('ready');
    expect(session.getState().exchange).toEqual({ said: 'walk-in 45', reply: NEW_KITCHEN_SENTENCE, source: 'wall', cook: 'AB' });
    expect(session.getState().draft).toBe('walk-in 45');

    worker.routes.toolsCall = WORKING.toolsCall;
    await session.say('walk-in 45');
    const calls = worker.callsOf('tools/call');
    expect(calls.at(-1)?.path).toBe(MINTED[1].mcpPath);
    expect(worker.argsOfCall(calls.length - 1).request_id).not.toBe(worker.argsOfCall(calls.length - 2).request_id);
  });

  it('a second closed answer before any call lands in the new kitchen stops the wall, and nothing is sent after', async () => {
    const worker = fakeWorker({ toolsCall: KITCHEN_CLOSED });
    const session = sessionOn(worker);
    await session.start();
    await session.say(WALK_IN);
    expect(worker.mintCount()).toBe(2);

    await session.say(WALK_IN);
    expect(session.getState().phase).toBe('stopped');
    expect(session.getState().stopMessage).toBe(STOPPED_MESSAGE);
    expect(worker.mintCount()).toBe(2);

    const requests = worker.sent.length;
    await session.say(WALK_IN);
    await session.retryStart();
    expect(worker.sent).toHaveLength(requests);
  });

  it('a call that lands in the new kitchen earns one more replacement later', async () => {
    const worker = fakeWorker({ toolsCall: KITCHEN_GONE });
    const session = sessionOn(worker);
    await session.start();
    await session.say(WALK_IN);
    worker.routes.toolsCall = WORKING.toolsCall;
    await session.say(WALK_IN);
    worker.routes.toolsCall = KITCHEN_GONE;
    await session.say('walk-in 37');
    expect(worker.mintCount()).toBe(3);
    expect(session.getState().phase).toBe('ready');
  });

  it('a failed new mint stops the wall with the plain message, and nothing is sent after', async () => {
    const worker = fakeWorker({ toolsCall: KITCHEN_GONE });
    worker.routes.mint = (count) => (count === 1 ? asJson(MINTED[0], 201) : asJson({ error: 'server_error' }, 500));
    const session = sessionOn(worker);
    await session.start();
    await session.say(WALK_IN);

    expect(session.getState().phase).toBe('stopped');
    expect(session.getState().stopMessage).toBe(STOPPED_MESSAGE);
    const requests = worker.sent.length;
    await session.say(WALK_IN);
    expect(worker.sent).toHaveLength(requests);
  });
});

describe('demo_full stops the wall at once', () => {
  it('a first mint answered 503 demo_full stops with the demo-full message, and nothing is sent after', async () => {
    const worker = fakeWorker({ mint: () => asJson({ error: 'demo_full', message: 'The demo is full for today.' }, 503) });
    const session = sessionOn(worker);
    await session.start();

    expect(session.getState().phase).toBe('stopped');
    expect(session.getState().stopMessage).toBe(DEMO_FULL_MESSAGE);
    await session.retryStart();
    await session.say(WALK_IN);
    expect(worker.sent).toHaveLength(1);
  });

  it('a tools/call answered isError demo_full stops with the demo-full message, and nothing is sent after', async () => {
    const worker = fakeWorker();
    const session = await loggedOnce(worker);
    const passBefore = session.getState().pass;
    worker.routes.toolsCall = toolError('demo_full', 'The demo is full for today.');

    await session.say('walk-in 45');

    expect(session.getState().phase).toBe('stopped');
    expect(session.getState().stopMessage).toBe(DEMO_FULL_MESSAGE);
    expect(session.getState().pass).toBe(passBefore);
    expect(worker.mintCount()).toBe(1);
    const requests = worker.sent.length;
    await session.say('walk-in 45');
    expect(worker.sent).toHaveLength(requests);
  });

  it('a new mint answered demo_full after a gone kitchen stops with the demo-full message', async () => {
    const worker = fakeWorker({ toolsCall: KITCHEN_GONE });
    worker.routes.mint = (count) => (count === 1 ? asJson(MINTED[0], 201) : asJson({ error: 'demo_full' }, 503));
    const session = sessionOn(worker);
    await session.start();
    await session.say(WALK_IN);
    expect(session.getState().stopMessage).toBe(DEMO_FULL_MESSAGE);
    expect(worker.mintCount()).toBe(2);
  });
});

interface OpenCheck {
  id: string;
  name: string;
}

const REACH_IN_TWO_OPEN: OpenCheck[] = [{ id: 'reach_in_2', name: 'Reach-in two' }];
const LISTS_BOTH: Route = (body) => answer(body, { tools: [{ name: 'log_reading' }, { name: 'due_now' }] });

function dueNowResult(openChecks: OpenCheck[]) {
  const names = openChecks.map((check) => check.name).join(', ');
  return {
    content: [{ type: 'text', text: openChecks.length === 0 ? 'No checks are open.' : `Open checks: ${names}.` }],
    structuredContent: { contractVersion: 1, businessDay: '2026-10-16', timeZone: 'America/Chicago', openChecks },
  };
}

function loggedResult(outcome: string, text: string, extra: Record<string, unknown> = {}) {
  return { content: [{ type: 'text', text }], structuredContent: { outcome, verdict: outcome, ...extra } };
}

// A Worker that lists due_now: it answers the list the test keeps in `record.open`, unless the test
// swaps `record.dueNow` for a failing or held-back route, and log_reading answers `record.logReading`.
function recordWorker() {
  const record: { open: OpenCheck[]; dueNow: Route | null; logReading: Route } = {
    open: [],
    dueNow: null,
    logReading: (body) => answer(body, IN_RANGE),
  };
  const listed: Route = (body) => answer(body, dueNowResult(record.open));
  const worker = fakeWorker({
    toolsList: LISTS_BOTH,
    toolsCall: (body) => (body.params?.name === 'due_now' ? (record.dueNow ?? listed)(body) : record.logReading(body)),
  });
  const dueNowCalls = () => worker.sent.filter((request) => request.body?.params?.name === 'due_now');
  return { worker, record, dueNowCalls };
}

describe('the open checks come from due_now at load and after every answered call', () => {
  it('loads the list once after start when tools/list lists due_now', async () => {
    const { worker, record, dueNowCalls } = recordWorker();
    record.open = REACH_IN_TWO_OPEN;
    const session = sessionOn(worker);
    await session.start();

    expect(dueNowCalls().length).toBe(1);
    expect(session.getState().openChecks).toEqual(REACH_IN_TWO_OPEN);
  });

  it('makes no due_now call and keeps the list null when tools/list does not list due_now', async () => {
    const worker = fakeWorker();
    const session = sessionOn(worker);
    await session.start();
    await session.say(WALK_IN);

    expect(worker.sent.filter((request) => request.body?.params?.name === 'due_now')).toEqual([]);
    expect(session.getState().openChecks).toBeNull();
  });

  it.each([
    ['in_range', loggedResult('in_range', 'Walk-in, 38, in range, AB', { value: 38 })],
    ['refused', loggedResult('refused', 'I need the number on the thermometer. What does reach-in two read?')],
    ['held', loggedResult('held', 'Say it one digit at a time. What does the walk-in read?', { prompt: { kind: 'digit_repeat', id: 'p-1' } })],
    ['nothing_to_fix', loggedResult('nothing_to_fix', 'There is nothing to fix.')],
  ])('follows a %s result with one due_now call', async (_outcome, result) => {
    const { worker, record, dueNowCalls } = recordWorker();
    const session = sessionOn(worker);
    await session.start();
    record.logReading = (body) => answer(body, result);
    record.open = REACH_IN_TWO_OPEN;

    await session.say(WALK_IN);

    expect(dueNowCalls()).toHaveLength(2);
    expect(session.getState().openChecks).toEqual(REACH_IN_TWO_OPEN);
  });

  it('makes no due_now call after a local reply', async () => {
    const { worker, dueNowCalls } = recordWorker();
    const session = sessionOn(worker);
    await session.start();

    await session.say('hello');

    expect(session.getState().exchange?.source).toBe('wall');
    expect(dueNowCalls()).toHaveLength(1);
  });

  it('makes no due_now call after a NOT LOGGED failure, and the list stays as it was', async () => {
    const { worker, record, dueNowCalls } = recordWorker();
    record.open = REACH_IN_TWO_OPEN;
    const session = sessionOn(worker);
    await session.start();
    const listBefore = session.getState().openChecks;
    record.logReading = () => asJson({ error: 'internal' }, 500);
    record.open = [];

    await session.say(WALK_IN);

    expect(session.getState().notLogged).not.toBeNull();
    expect(dueNowCalls()).toHaveLength(1);
    expect(session.getState().openChecks).toBe(listBefore);
  });

  it('makes no due_now call once the wall has stopped', async () => {
    const { worker, record, dueNowCalls } = recordWorker();
    const session = sessionOn(worker);
    await session.start();
    record.logReading = toolError('demo_full', 'The demo is full for today.');

    await session.say(WALK_IN);

    expect(session.getState().phase).toBe('stopped');
    expect(dueNowCalls()).toHaveLength(1);
  });

  it.each<[string, Route]>([
    ['an HTTP 500', () => asJson({ error: 'internal' }, 500)],
    ['an isError answer', toolError('server_fault', 'Tolsey could not log that. Try again.')],
    ['no answer before the timeout', NEVER_ANSWERS],
  ])('leaves the list unchanged and says nothing when the refresh gets %s', async (_failure, route) => {
    const { worker, record } = recordWorker();
    record.open = REACH_IN_TWO_OPEN;
    const session = sessionOn(worker);
    await session.start();
    const before = session.getState();
    record.dueNow = route;

    await session.say(WALK_IN);

    const after = session.getState();
    expect(after.openChecks).toBe(before.openChecks);
    expect(after.notLogged).toBeNull();
    expect(after.pass).toMatchObject({ outcome: 'in_range', value: 38 });
    expect(after.announcementSeq - before.announcementSeq).toBe(1);
  });

  it('shows the reply and the pass before the list answers', async () => {
    const { worker, record } = recordWorker();
    const session = sessionOn(worker);
    await session.start();
    const list = heldBack<undefined>();
    record.dueNow = async (body) => {
      await list.promise;
      return answer(body, dueNowResult(REACH_IN_TWO_OPEN));
    };

    const saying = session.say(WALK_IN);
    await settle();

    expect(session.getState().exchange?.reply).toBe('Walk-in, 38, in range, AB');
    expect(session.getState().pass).toMatchObject({ value: 38 });
    expect(controlsEnabled(session.getState())).toBe(true);
    expect(session.getState().openChecks).toEqual([]);

    list.release(undefined);
    await saying;
    expect(session.getState().openChecks).toEqual(REACH_IN_TWO_OPEN);
  });

  it('a refresh after a refusal never writes the status region', async () => {
    const { worker, record } = recordWorker();
    const session = sessionOn(worker);
    await session.start();
    record.logReading = (body) => answer(body, loggedResult('refused', 'I need the number on the thermometer. What does reach-in two read?'));
    record.open = REACH_IN_TWO_OPEN;
    const seqBefore = session.getState().announcementSeq;

    await session.say('reach-in two is fine');

    expect(session.getState().openChecks).toEqual(REACH_IN_TWO_OPEN);
    expect(session.getState().announcementSeq - seqBefore).toBe(1);
  });

  it('never lets an older refresh that answers late replace a newer list', async () => {
    const { worker, record } = recordWorker();
    const first = heldBack<undefined>();
    let refreshes = 0;
    record.dueNow = async (body) => {
      refreshes += 1;
      if (refreshes === 1) {
        await first.promise;
        return answer(body, dueNowResult([]));
      }
      return answer(body, dueNowResult(REACH_IN_TWO_OPEN));
    };
    const session = sessionOn(worker);
    const starting = session.start();
    await settle();
    expect(session.getState().phase).toBe('ready');

    await session.say('reach-in two is fine');
    first.release(undefined);
    await starting;

    expect(refreshes).toBe(2);
    expect(session.getState().openChecks).toEqual(REACH_IN_TWO_OPEN);
  });

  it("loads the new kitchen's list after a closed kitchen is replaced", async () => {
    const { worker, record, dueNowCalls } = recordWorker();
    record.open = REACH_IN_TWO_OPEN;
    const session = sessionOn(worker);
    await session.start();
    record.logReading = KITCHEN_CLOSED;
    record.open = [];

    await session.say(WALK_IN);

    expect(session.getState().exchange?.reply).toBe(NEW_KITCHEN_SENTENCE);
    expect(dueNowCalls().map((request) => request.path)).toEqual([MINTED[0].mcpPath, MINTED[1].mcpPath]);
    expect(session.getState().openChecks).toEqual([]);
  });

  it("shows no list, never the closed kitchen's, when the new kitchen's due_now fails", async () => {
    const { worker, record, dueNowCalls } = recordWorker();
    record.open = REACH_IN_TWO_OPEN;
    const session = sessionOn(worker);
    await session.start();
    expect(session.getState().openChecks).toEqual(REACH_IN_TWO_OPEN);
    record.logReading = KITCHEN_CLOSED;
    record.dueNow = () => asJson({ error: 'internal' }, 500);

    await session.say(WALK_IN);

    expect(session.getState().exchange?.reply).toBe(NEW_KITCHEN_SENTENCE);
    expect(dueNowCalls().map((request) => request.path)).toEqual([MINTED[0].mcpPath, MINTED[1].mcpPath]);
    expect(session.getState().openChecks).toBeNull();
  });
});

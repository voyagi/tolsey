import { describe, expect, it, vi } from 'vitest';
import { CALL_TIMEOUT_MS, McpClientError, mintKitchen, openMcpSession, PROTOCOL_VERSION, type FetchLike } from './mcp-client';

const BASE = new URL('http://wall.test/');
const ENDPOINT = new URL('/mcp/k/0123456789abcdef0123456789abcdef', BASE);

interface SentRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { id?: number; method?: string; [key: string]: unknown } | undefined;
}

type Answer = (request: SentRequest) => Response;

// Records every request and answers each from the next scripted answer, in order.
function scriptedFetch(answers: Answer[]): { fetchFn: FetchLike; sent: SentRequest[] } {
  const sent: SentRequest[] = [];
  const queue = [...answers];
  const fetchFn: FetchLike = async (url, init) => {
    const request: SentRequest = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    sent.push(request);
    const answer = queue.shift();
    if (!answer) throw new Error(`no scripted answer for request ${sent.length}`);
    return answer(request);
  };
  return { fetchFn, sent };
}

function asJson(message: unknown, status = 200): Response {
  return new Response(JSON.stringify(message), { status, headers: { 'content-type': 'application/json' } });
}

function asEventStream(messages: unknown[]): Response {
  const body = messages.map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const initializeAt =
  (protocolVersion: string): Answer =>
  (request) =>
    asJson({ jsonrpc: '2.0', id: request.body?.id, result: { protocolVersion, capabilities: {}, serverInfo: { name: 'tolsey', version: '0.1.0' } } });

const accepted: Answer = () => new Response(null, { status: 202 });

const READING_RESULT = {
  content: [{ type: 'text', text: 'Walk-in, 38, in range, AB' }],
  structuredContent: { outcome: 'in_range', value: 38 },
};

async function readySession(...answers: Answer[]) {
  const script = scriptedFetch([initializeAt(PROTOCOL_VERSION), accepted, ...answers]);
  const session = await openMcpSession(ENDPOINT, script.fetchFn);
  return { session, sent: script.sent };
}

describe('a tools/call answer is read in either encoding the server may choose', () => {
  it.each([
    ['as JSON', (request: SentRequest) => asJson({ jsonrpc: '2.0', id: request.body?.id, result: READING_RESULT })],
    [
      'as an event stream whose earlier data line is an unrelated notification',
      (request: SentRequest) =>
        asEventStream([
          { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'working' } },
          { jsonrpc: '2.0', id: request.body?.id, result: READING_RESULT },
        ]),
    ],
  ])('reads the answer sent %s and matches it by its JSON-RPC id', async (_encoding, answer) => {
    const { session } = await readySession(answer);
    await expect(session.callTool('log_reading', { words: 'the walk-in reads 38' })).resolves.toEqual(READING_RESULT);
  });

  it('skips a message carrying another id on the same stream and takes the one matching the request', async () => {
    const { session } = await readySession((request) =>
      asEventStream([
        { jsonrpc: '2.0', id: 999, result: { content: [{ type: 'text', text: 'not this one' }] } },
        { jsonrpc: '2.0', id: request.body?.id, result: READING_RESULT },
      ]),
    );
    await expect(session.callTool('log_reading', {})).resolves.toEqual(READING_RESULT);
  });
});

describe('the protocol version is 2025-11-25 or nothing', () => {
  it('refuses an initialize answered at 2025-06-18 and sends no initialized notification', async () => {
    const { fetchFn, sent } = scriptedFetch([initializeAt('2025-06-18'), accepted]);
    await expect(openMcpSession(ENDPOINT, fetchFn)).rejects.toMatchObject({ kind: 'protocol' });
    expect(sent.map((request) => request.body?.method)).toEqual(['initialize']);
  });

  it('opens a session that reports 2025-11-25 when the server answers at that version', async () => {
    const { session } = await readySession();
    expect(session.protocolVersion).toBe('2025-11-25');
  });
});

describe('the initialized notification must be answered 202', () => {
  it('refuses a notifications/initialized answered 200 instead of 202', async () => {
    const { fetchFn } = scriptedFetch([initializeAt(PROTOCOL_VERSION), () => asJson({}, 200)]);
    const failure = await openMcpSession(ENDPOINT, fetchFn).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(McpClientError);
    expect(failure).toMatchObject({ kind: 'protocol', status: 200 });
  });
});

describe('the transport headers', () => {
  it('sends accept "application/json, text/event-stream" and a JSON content type on initialize, with no protocol version header yet', async () => {
    const { sent } = await readySession();
    expect(sent[0].headers).toMatchObject({ accept: 'application/json, text/event-stream', 'content-type': 'application/json' });
    expect(sent[0].headers).not.toHaveProperty('mcp-protocol-version');
    expect(sent[0].body).toMatchObject({ method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  });

  it('sends mcp-protocol-version 2025-11-25 on every POST after initialize', async () => {
    const { session, sent } = await readySession(
      (request) => asJson({ jsonrpc: '2.0', id: request.body?.id, result: { tools: [{ name: 'log_reading' }] } }),
      (request) => asJson({ jsonrpc: '2.0', id: request.body?.id, result: READING_RESULT }),
    );
    await session.listTools();
    await session.callTool('log_reading', {});
    const after = sent.slice(1);
    expect(after.map((request) => request.body?.method)).toEqual(['notifications/initialized', 'tools/list', 'tools/call']);
    for (const request of after) expect(request.headers['mcp-protocol-version']).toBe('2025-11-25');
  });

  it('echoes an mcp-session-id the server returns on every later POST', async () => {
    const withSession: Answer = (request) => {
      const response = initializeAt(PROTOCOL_VERSION)(request);
      response.headers.set('mcp-session-id', 'session-1');
      return response;
    };
    const { fetchFn, sent } = scriptedFetch([withSession, accepted]);
    await openMcpSession(ENDPOINT, fetchFn);
    expect(sent[0].headers).not.toHaveProperty('mcp-session-id');
    expect(sent[1].headers['mcp-session-id']).toBe('session-1');
  });
});

describe('minting a scratch kitchen', () => {
  const MINTED = {
    id: '0123456789abcdef0123456789abcdef',
    mcpPath: '/mcp/k/0123456789abcdef0123456789abcdef',
    expiresAt: '2026-10-17T10:00:00.000Z',
    closesAt: '2026-10-17T08:43:00.000Z',
  };

  it('posts the body {} with content-type application/json to /api/kitchens', async () => {
    const { fetchFn, sent } = scriptedFetch([() => asJson(MINTED, 201)]);
    await expect(mintKitchen(BASE, fetchFn)).resolves.toEqual(MINTED);
    expect(sent[0]).toMatchObject({ url: 'http://wall.test/api/kitchens', method: 'POST', body: {} });
    expect(sent[0].headers['content-type']).toBe('application/json');
  });

  it('throws kind http with status 503 and code demo_full when the demo is full', async () => {
    const { fetchFn } = scriptedFetch([() => asJson({ error: 'demo_full', message: 'The demo is full for today. Try again tomorrow.' }, 503)]);
    await expect(mintKitchen(BASE, fetchFn)).rejects.toMatchObject({ kind: 'http', status: 503, code: 'demo_full' });
  });

  it('refuses a 201 whose kitchen path points at another host', async () => {
    const { fetchFn } = scriptedFetch([() => asJson({ ...MINTED, mcpPath: '//elsewhere.test/mcp' }, 201)]);
    await expect(mintKitchen(BASE, fetchFn)).rejects.toMatchObject({ kind: 'protocol', status: 201 });
  });

  // The URL parser reads a backslash as a slash and drops tabs and newlines, so each of these opens
  // with one slash and still resolves to another host, or to no URL at all.
  it.each([['/\\elsewhere.test/mcp'], ['/\t/elsewhere.test/mcp'], ['/\n/elsewhere.test/mcp'], ['/\\[bad/mcp']])(
    'refuses a 201 whose kitchen path %j leaves the wall origin once resolved',
    async (mcpPath) => {
      const { fetchFn } = scriptedFetch([() => asJson({ ...MINTED, mcpPath }, 201)]);
      await expect(mintKitchen(BASE, fetchFn)).rejects.toMatchObject({ kind: 'protocol', status: 201 });
    },
  );
});

describe('failures on the wire', () => {
  it('throws kind network when fetch itself rejects', async () => {
    const fetchFn: FetchLike = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(openMcpSession(ENDPOINT, fetchFn)).rejects.toMatchObject({ kind: 'network' });
  });

  it('throws kind protocol, naming the status, when no message in the body matches the request id', async () => {
    const { session } = await readySession(() => asJson({ jsonrpc: '2.0', id: 999, result: READING_RESULT }));
    const failure = await session.callTool('log_reading', {}).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: 'protocol', status: 200 });
    expect((failure as Error).message).toContain('status 200');
  });

  it('throws kind protocol carrying the JSON-RPC code when the server answers the request with an error', async () => {
    const { session } = await readySession((request) =>
      asJson({ jsonrpc: '2.0', id: request.body?.id, error: { code: -32602, message: 'Invalid params' } }),
    );
    await expect(session.callTool('log_reading', {})).rejects.toMatchObject({ kind: 'protocol', code: -32602 });
  });

  it.each([
    ['an empty body', () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['a body that is not JSON', () => new Response('<html>busy</html>', { status: 200, headers: { 'content-type': 'text/html' } })],
  ])('throws kind protocol for a tools/call answered with %s', async (_shape, reply) => {
    const { session } = await readySession(reply);
    await expect(session.callTool('log_reading', {})).rejects.toMatchObject({ kind: 'protocol', status: 200 });
  });
});

const NOT_YET = 'still pending';

// Fails the test with a plain error when the promise has not settled by the deadline, so a missing
// timeout shows as a wrong rejection rather than as the test runner's own timeout.
function settledWithin<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(NOT_YET)), deadlineMs);
    }),
  ]);
}

// A fetch that never answers on its own and rejects as a browser does once its signal aborts.
function silentUntilAborted(): FetchLike {
  return (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (signal?.aborted) abort();
      signal?.addEventListener('abort', abort, { once: true });
    });
}

describe('a call that gets no answer times out', () => {
  it('waits 10 seconds by default', () => {
    expect(CALL_TIMEOUT_MS).toBe(10_000);
  });

  it('aborts a tools/call whose answer never comes after timeoutMs and throws kind timeout', async () => {
    const opened = scriptedFetch([initializeAt(PROTOCOL_VERSION), accepted]);
    const silent = silentUntilAborted();
    let answered = 0;
    const fetchFn: FetchLike = (url, init) => {
      answered += 1;
      return answered <= 2 ? opened.fetchFn(url, init) : silent(url, init);
    };
    const session = await openMcpSession(ENDPOINT, fetchFn, { timeoutMs: 20 });
    await expect(settledWithin(session.callTool('log_reading', {}), 1_000)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('times out a mint that never answers', async () => {
    await expect(settledWithin(mintKitchen(BASE, silentUntilAborted(), {}, { timeoutMs: 20 }), 1_000)).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('without a timeoutMs, still waits at 9.999 seconds and gives up at 10', async () => {
    const opened = scriptedFetch([initializeAt(PROTOCOL_VERSION), accepted]);
    const silent = silentUntilAborted();
    let answered = 0;
    const fetchFn: FetchLike = (url, init) => {
      answered += 1;
      return answered <= 2 ? opened.fetchFn(url, init) : silent(url, init);
    };
    const session = await openMcpSession(ENDPOINT, fetchFn);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let outcome: unknown = NOT_YET;
      const call = session.callTool('log_reading', {}).then(
        () => 'answered',
        (error: unknown) => error,
      );
      void call.then((value) => {
        outcome = value;
      });
      await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS - 1);
      expect(outcome).toBe(NOT_YET);
      await vi.advanceTimersByTimeAsync(1);
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      expect(outcome).toMatchObject({ kind: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a fetch that rejects for any other reason is kind network, never timeout', async () => {
    const opened = scriptedFetch([initializeAt(PROTOCOL_VERSION), accepted]);
    let answered = 0;
    const fetchFn: FetchLike = async (url, init) => {
      answered += 1;
      if (answered <= 2) return opened.fetchFn(url, init);
      throw new TypeError('Failed to fetch');
    };
    const session = await openMcpSession(ENDPOINT, fetchFn, { timeoutMs: 1_000 });
    await expect(session.callTool('log_reading', {})).rejects.toMatchObject({ kind: 'network' });
  });
});

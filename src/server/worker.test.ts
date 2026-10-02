import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dumpRecordTables, openTestD1, type TestD1 } from '../test-support/d1';
import { byId, errorById, sendRaw, type RawResponse } from '../test-support/raw-mcp';
import productionWorker, { createWorker, type WorkerEnv } from './worker';

const LISTED = 'localhost,127.0.0.1,tolsey.taranity.com';
const JSON_AND_STREAM = 'application/json, text/event-stream';
const BODY_CAP = 65_536;
const UNKNOWN_KITCHEN = '0123456789abcdef0123456789abcdef';
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const UNICODE_HOST = `b${String.fromCharCode(0xfc)}cher.example`;

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw-probe', version: '1.0.0' } },
});
const TOOLS_LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

interface RawOptions {
  method?: string;
  host?: string | null;
  origin?: string;
  contentType?: string;
  body?: string;
  allowed?: string | undefined;
}

// A tools/list request padded inside _meta to exactly the given number of bytes (ASCII only).
function paddedToolsList(totalBytes: number): string {
  const shaped = (pad: string) =>
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { pad } } });
  return shaped('x'.repeat(totalBytes - shaped('').length));
}

// A kitchens body carrying only a label, padded with trailing spaces to exactly the given number of
// bytes (ASCII only), so under the cap it is still a body the route mints from.
function paddedKitchensBody(totalBytes: number): string {
  return JSON.stringify({ label: 'conformance' }).padEnd(totalBytes, ' ');
}

function jsonBody(response: RawResponse): Record<string, unknown> {
  return JSON.parse(response.bodyText) as Record<string, unknown>;
}

describe('the Worker in front of the MCP handler and the kitchens route', () => {
  let d1: TestD1;
  const worker = createWorker({ clock: { now: () => Date.UTC(2026, 9, 20, 15, 0) } });

  beforeAll(async () => {
    d1 = await openTestD1();
  });

  afterAll(async () => {
    await d1?.dispose();
  });

  function envWith(allowed: string | undefined): WorkerEnv {
    return {
      ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
      ALLOWED_HOSTNAMES: allowed,
      DB: d1.db,
    };
  }

  // The Host header is set here on purpose, or left out on purpose: a Node Request carries none.
  function send(path: string, options: RawOptions = {}): Promise<RawResponse> {
    const method = options.method ?? 'POST';
    const headers: Record<string, string> = { accept: JSON_AND_STREAM };
    const host = options.host === undefined ? 'localhost' : options.host;
    if (host !== null) headers.host = host;
    if (options.origin !== undefined) headers.origin = options.origin;
    if (method === 'POST') headers['content-type'] = options.contentType ?? 'application/json';
    const env = envWith('allowed' in options ? options.allowed : LISTED);
    return sendRaw(
      { url: new URL(path, 'http://localhost'), fetch: (url, init) => worker.fetch(new Request(url, init), env) },
      { method, headers, ...(method === 'POST' ? { body: options.body ?? INITIALIZE } : {}) },
    );
  }

  function clientFetch(url: string | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(url, init);
    const headers = new Headers(request.headers);
    headers.set('host', 'localhost');
    return worker.fetch(new Request(request, { headers }), envWith(LISTED));
  }

  async function connectClient(options: ConstructorParameters<typeof Client>[1]): Promise<Client> {
    const client = new Client({ name: 'era-probe', version: '1.0.0' }, options);
    await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { fetch: clientFetch }));
    return client;
  }

  describe('the allowlist', () => {
    const MALFORMED: [string, string | undefined][] = [
      ['undefined', undefined],
      ['empty', ''],
      ['only a comma between spaces', ' , '],
      ['a URL', 'https://tolsey.taranity.com'],
      ['a path', 'localhost/mcp'],
      ['a port', 'localhost:8787'],
      // Each of these can never equal a request's Host, so it would lock visitors out quietly.
      ['a wildcard beside a good entry', 'localhost,*.taranity.com'],
      ['a Unicode name beside a good entry', `localhost,${UNICODE_HOST}`],
      ['a trailing dot beside a good entry', 'localhost,tolsey.taranity.com.'],
      ['a label starting with a hyphen', 'localhost,-tolsey.example'],
      // The SDK compares the hostname a URL parser makes of the Host header, so these never match either.
      ['a malformed IPv6 literal beside a good entry', 'localhost,[abc..def]'],
      ['an IPv6 literal not in its compressed form', 'localhost,[0:0:0:0:0:0:0:1]'],
      ['an IPv4 address in a short form', 'localhost,127.1'],
      ['whitespace inside an entry', 'localhost,tolsey taranity.com'],
      ['an IPv6 literal missing its closing bracket', 'localhost,[::1'],
      ['an IPv6 literal without its brackets', 'localhost,::1'],
    ];

    it.each(MALFORMED)('answers /mcp with a named 503 and never throws when ALLOWED_HOSTNAMES is %s', async (_label, allowed) => {
      const response = await send('/mcp', { allowed });
      expect(response.status).toBe(503);
      expect(response.contentType).toMatch(/^application\/json/);
      expect(jsonBody(response)).toMatchObject({ error: 'allowlist_unconfigured', message: expect.stringMatching(/ALLOWED_HOSTNAMES/) });
    });

    it.each(MALFORMED)('answers POST /api/kitchens with a named 503 when ALLOWED_HOSTNAMES is %s', async (_label, allowed) => {
      const response = await send('/api/kitchens', { allowed, body: '{}' });
      expect(response.status).toBe(503);
      expect(jsonBody(response)).toMatchObject({ error: 'allowlist_unconfigured' });
    });

    it('names the malformed entry in the 503 message', async () => {
      const response = await send('/mcp', { allowed: 'localhost,localhost:8787' });
      expect(jsonBody(response).message).toMatch(/localhost:8787/);
    });

    it('names the form a Host header is compared in when an entry is written another way', async () => {
      const response = await send('/mcp', { allowed: 'localhost,[0:0:0:0:0:0:0:1]' });
      expect(jsonBody(response).message).toMatch(/give \[::1\]/);
    });

    // Without its own check the entry would fail the hostname label check, a 503 that names the
    // wrong problem.
    it('names whitespace inside an entry as its problem', async () => {
      const response = await send('/mcp', { allowed: 'localhost,tolsey taranity.com' });
      expect(jsonBody(response).message).toBe('ALLOWED_HOSTNAMES entry "tolsey taranity.com" holds whitespace');
    });

    it.each(['[::1', '[fe80::1%eth0]'])('names the entry %s, which opens a bracket, as no bracketed IPv6 literal', async (entry) => {
      const response = await send('/mcp', { allowed: `localhost,${entry}` });
      expect(jsonBody(response).message).toBe(`ALLOWED_HOSTNAMES entry "${entry}" is not a bracketed IPv6 literal`);
    });

    // Each shape would otherwise get advice for a different shape: an address's colons read as a
    // port, a bracketed address with a port read as a broken address, a trailing dot read as non-ASCII.
    it.each([
      ['localhost:8787', 'holds a port: give the hostname without it'],
      ['::1', 'is an IPv6 literal without its brackets: give [::1]'],
      ['0:0:0:0:0:0:0:1', 'is an IPv6 literal without its brackets: give [::1]'],
      ['fe80::1%eth0', 'is not an address a Host header can carry'],
      ['[::1]:8787', 'holds a port: give the hostname without it'],
      ['tolsey.taranity.com.', 'ends in a dot: give the hostname without it'],
    ])('names the problem with the entry %s', async (entry, problem) => {
      const response = await send('/mcp', { allowed: `localhost,${entry}` });
      expect(jsonBody(response).message).toBe(`ALLOWED_HOSTNAMES entry "${entry}" ${problem}`);
    });

    it('accepts a bracketed IPv6 literal and a Host of [::1] with a port', async () => {
      const response = await send('/mcp', { allowed: '[::1],localhost', host: '[::1]:8787' });
      expect(byId(response, 1)).toMatchObject({ protocolVersion: '2025-11-25' });
    });

    it('lowercases every entry, so a listed LocalHost admits Host localhost', async () => {
      const response = await send('/mcp', { allowed: 'LocalHost,Tolsey.Taranity.com' });
      expect(byId(response, 1)).toMatchObject({ protocolVersion: '2025-11-25' });
    });
  });

  describe('Host and Origin', () => {
    it('refuses Host attacker.example with 403 naming it', async () => {
      const response = await send('/mcp', { host: 'attacker.example' });
      expect(response.status).toBe(403);
      expect(errorById(response, null).message).toBe('Invalid Host: attacker.example');
    });

    it('refuses a request with no Host header with 403', async () => {
      const response = await send('/mcp', { host: null });
      expect(response.status).toBe(403);
    });

    it('refuses the suffix trick tolsey.taranity.com.attacker.example with 403 (E27)', async () => {
      const response = await send('/mcp', { host: 'tolsey.taranity.com.attacker.example' });
      expect(response.status).toBe(403);
    });

    it('accepts Host LOCALHOST as localhost (E27)', async () => {
      const response = await send('/mcp', { host: 'LOCALHOST' });
      expect(byId(response, 1)).toMatchObject({ protocolVersion: '2025-11-25' });
    });

    it('refuses Host [::1]:8787 when [::1] is not listed', async () => {
      const response = await send('/mcp', { host: '[::1]:8787' });
      expect(response.status).toBe(403);
    });

    it('refuses a Unicode Host that is not on the list', async () => {
      const response = await send('/mcp', { host: UNICODE_HOST });
      expect(response.status).toBe(403);
    });

    it('refuses Origin null with 403', async () => {
      const response = await send('/mcp', { origin: 'null' });
      expect(response.status).toBe(403);
    });

    it('refuses Origin https://attacker.example with 403', async () => {
      const response = await send('/mcp', { origin: 'https://attacker.example' });
      expect(response.status).toBe(403);
    });

    it('accepts Origin http://localhost:5173, whose hostname is listed', async () => {
      const response = await send('/mcp', { origin: 'http://localhost:5173' });
      expect(byId(response, 1)).toMatchObject({ protocolVersion: '2025-11-25' });
    });

    it('holds /api/kitchens behind the same Host check', async () => {
      const response = await send('/api/kitchens', { host: 'attacker.example', body: '{}' });
      expect(response.status).toBe(403);
    });
  });

  describe('routes', () => {
    it('answers GET /mcp/ with a JSON-RPC 405, never page HTML', async () => {
      const response = await send('/mcp/', { method: 'GET' });
      expect(response.status).toBe(405);
      expect(errorById(response, null).code).toBe(-32000);
    });

    it('answers GET /mcp/k/<unknown id> with a JSON 404', async () => {
      const response = await send(`/mcp/k/${UNKNOWN_KITCHEN}`, { method: 'GET' });
      expect(response.status).toBe(404);
      expect(response.contentType).toMatch(/^application\/json/);
    });

    // The answer must not differ, so the shape of a path tells a prober nothing about which ids exist.
    it.each([
      ['31 hex digits', UNKNOWN_KITCHEN.slice(1)],
      ['33 hex digits', `${UNKNOWN_KITCHEN}0`],
      ['uppercase hex digits', UNKNOWN_KITCHEN.toUpperCase()],
      ['a character outside hex', `${UNKNOWN_KITCHEN.slice(1)}g`],
      ['an extra path segment', `${UNKNOWN_KITCHEN}/extra`],
      ['a trailing slash', `${UNKNOWN_KITCHEN}/`],
    ])('answers a kitchen path with %s exactly as it answers an unknown well-formed id', async (_label, id) => {
      const unknown = await send(`/mcp/k/${UNKNOWN_KITCHEN}`);
      const malformed = await send(`/mcp/k/${id}`);
      expect(unknown.status).toBe(404);
      expect(malformed).toEqual(unknown);
    });

    it('stamps a kitchen minted through the default export with the wall clock', async () => {
      const request = new Request('http://localhost/api/kitchens', {
        method: 'POST',
        headers: { host: 'localhost', 'content-type': 'application/json' },
        body: '{}',
      });
      const before = Date.now();
      const response = await productionWorker.fetch(request, envWith(LISTED));
      const after = Date.now();
      expect(response.status).toBe(201);
      const { id } = (await response.json()) as { id: string };
      const row = await d1.db.prepare('SELECT created_at FROM kitchens WHERE id = ?1').bind(id).first<{ created_at: number }>();
      expect(row?.created_at).toBeGreaterThanOrEqual(before);
      expect(row?.created_at).toBeLessThanOrEqual(after);
    });

    it('hands GET / to the static assets', async () => {
      const response = await send('/', { method: 'GET' });
      expect(response.bodyText).toBe('asset');
    });

    it('mints through the whole guard chain with label conformance', async () => {
      const response = await send('/api/kitchens', { body: JSON.stringify({ label: 'conformance' }) });
      expect(response.status).toBe(201);
      expect(jsonBody(response).id).toMatch(/^[0-9a-f]{32}$/);
    });

    it('mints an unlabelled kitchen when the POST has no body', async () => {
      const response = await send('/api/kitchens', { body: '' });
      expect(response.status).toBe(201);
      const row = await d1.db
        .prepare('SELECT label FROM kitchens WHERE id = ?1')
        .bind(jsonBody(response).id)
        .first<{ label: string | null }>();
      expect(row).toEqual({ label: null });
    });

    it('answers a kitchens body that is not JSON with 400 invalid_body', async () => {
      const response = await send('/api/kitchens', { body: '{"label":' });
      expect(response.status).toBe(400);
      expect(jsonBody(response)).toEqual({ error: 'invalid_body' });
    });
  });

  describe('bodies', () => {
    it('reads a body of exactly 64 KiB and lets the SDK answer it (E26)', async () => {
      const body = paddedToolsList(BODY_CAP);
      expect(new TextEncoder().encode(body).byteLength).toBe(BODY_CAP);
      const response = await send('/mcp', { body });
      expect(response.status).toBe(200);
      expect(byId(response, 1)).toMatchObject({ tools: expect.any(Array) });
    });

    it('answers a body one byte over 64 KiB with a JSON 413 (E26)', async () => {
      const body = paddedToolsList(BODY_CAP + 1);
      expect(new TextEncoder().encode(body).byteLength).toBe(BODY_CAP + 1);
      const response = await send('/mcp', { body });
      expect(response.status).toBe(413);
      expect(response.contentType).toMatch(/^application\/json/);
    });

    it('mints from a kitchens body of exactly 64 KiB', async () => {
      const body = paddedKitchensBody(BODY_CAP);
      expect(new TextEncoder().encode(body).byteLength).toBe(BODY_CAP);
      const response = await send('/api/kitchens', { body });
      expect(response.status).toBe(201);
    });

    it('answers a kitchens body one byte over 64 KiB with 413 body_too_large and mints nothing', async () => {
      const body = paddedKitchensBody(BODY_CAP + 1);
      expect(new TextEncoder().encode(body).byteLength).toBe(BODY_CAP + 1);
      const before = await dumpRecordTables(d1.db);
      const response = await send('/api/kitchens', { body });
      expect(response.status).toBe(413);
      expect(response.contentType).toMatch(/^application\/json/);
      expect(jsonBody(response)).toEqual({ error: 'body_too_large' });
      expect(await dumpRecordTables(d1.db)).toBe(before);
    });

    it('answers a text/plain POST with 415', async () => {
      const response = await send('/mcp', { contentType: 'text/plain', body: TOOLS_LIST });
      expect(response.status).toBe(415);
    });

    it('answers a body with a UTF-8 byte order mark and a charset parameter with a JSON-RPC result', async () => {
      const response = await send('/mcp', {
        contentType: 'application/json; charset=utf-8',
        body: `${BYTE_ORDER_MARK}${TOOLS_LIST}`,
      });
      expect(response.status).toBe(200);
      expect(byId(response, 1)).toMatchObject({ tools: expect.any(Array) });
    });

    it.each([
      ['an empty body', ''],
      ['a body of invalid JSON', '{'],
    ])('answers %s through the whole chain with the SDK -32700 parse error, never a 500', async (_label, body) => {
      const response = await send('/mcp', { body });
      expect(response.status).toBe(400);
      expect(errorById(response, null).code).toBe(-32700);
    });

    // Valid JSON that is no JSON-RPC message belongs to neither era, so the version refusal would
    // send a client chasing a protocol version when its message is what is wrong.
    it.each(['null', '{}', '[]', '[{}]', '1', 'true'])(
      'answers the JSON body %s, which is no JSON-RPC message, with 400 and -32600, never the version refusal',
      async (body) => {
        const response = await send('/mcp', { body });
        const error = errorById(response, null);
        expect(response.status).toBe(400);
        expect(error.code).toBe(-32600);
        expect(error.message).not.toMatch(/protocol version/);
      },
    );
  });

  describe('the modern era', () => {
    it('refuses a request the SDK classifies modern with 400 and a -32000 error naming the supported versions', async () => {
      const seen: { status: number; body: string }[] = [];
      const recording = async (url: string | URL, init?: RequestInit) => {
        const response = await clientFetch(url, init);
        seen.push({ status: response.status, body: await response.clone().text() });
        return response;
      };
      const client = new Client(
        { name: 'era-probe', version: '1.0.0' },
        { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } },
      );
      await expect(
        client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { fetch: recording })),
      ).rejects.toThrow();
      expect(seen[0]?.status).toBe(400);
      const refusal = JSON.parse(seen[0]?.body ?? '{}') as { error?: { code: number; message: string } };
      expect(refusal.error?.code).toBe(-32000);
      expect(refusal.error?.message).toBe('Unsupported protocol version. Supported: 2025-11-25, 2025-06-18, 2025-03-26');
    });

    it('connects a client in auto negotiation at 2025-11-25', async () => {
      const client = await connectClient({ capabilities: {}, versionNegotiation: { mode: 'auto' } });
      try {
        expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
      } finally {
        await client.close();
      }
    });

    it('fails to connect a client pinned to 2026-07-28', async () => {
      await expect(
        connectClient({ capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } }),
      ).rejects.toThrow();
    });
  });
});

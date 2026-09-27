import { describe, expect, it } from 'vitest';
import type { D1Like } from '../store/port';
import worker, { type WorkerEnv } from './worker';

const unusedDb: D1Like = {
  prepare: () => {
    throw new Error('not used by this test');
  },
  batch: async () => {
    throw new Error('not used by this test');
  },
};

const env: WorkerEnv = {
  ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
  ALLOWED_HOSTNAMES: 'localhost',
  DB: unusedDb,
};

function initializeRequest(host: string, origin?: string): Request {
  return new Request(`http://${host}/mcp`, {
    method: 'POST',
    headers: {
      host,
      ...(origin ? { origin } : {}),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    }),
  });
}

async function readJsonRpc(response: Response): Promise<{ result?: Record<string, unknown> }> {
  const text = await response.text();
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return JSON.parse(text);
  const data = text.split('\n').find((line) => line.startsWith('data:'));
  if (!data) throw new Error(`event stream carried no data line: ${text}`);
  return JSON.parse(data.slice('data:'.length));
}

describe('worker /mcp endpoint', () => {
  it('answers an initialize for protocol 2025-11-25 with that version', async () => {
    const response = await worker.fetch(initializeRequest('localhost'), env);
    expect(response.status).toBe(200);
    const message = await readJsonRpc(response);
    expect(message.result?.protocolVersion).toBe('2025-11-25');
    expect(message.result?.serverInfo).toMatchObject({ name: 'tolsey' });
  });

  it('refuses a request whose Host is not on the allowlist', async () => {
    const response = await worker.fetch(initializeRequest('attacker.example'), env);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('accepts a browser request whose full Origin has an allowed hostname and a port', async () => {
    // The allowlist holds bare hostnames; the SDK compares the Origin's hostname, not the whole origin.
    const response = await worker.fetch(initializeRequest('localhost', 'http://localhost:5173'), env);
    expect(response.status).toBe(200);
  });

  it('refuses a browser request from an Origin whose hostname is not on the allowlist', async () => {
    const response = await worker.fetch(initializeRequest('localhost', 'https://attacker.example'), env);
    expect(response.status).toBe(403);
  });

  it('hands every other path to the static assets', async () => {
    const response = await worker.fetch(new Request('http://localhost/'), env);
    expect(await response.text()).toBe('asset');
  });
});

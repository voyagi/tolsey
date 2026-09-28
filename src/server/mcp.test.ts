import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { Store } from '../store/port';
import { DEMO_PROFILE, ROWS_PER_WRITE, RULES, RULES_VERSION, STORE_LIMITS } from './data';
import { createServer, type ServerDeps } from './mcp';

const WORDS = 'the walk-in reads 38';

// The stub sits at the platform boundary: a D1 failure whose message carries the call's words and
// initials, the way a constraint error can quote the values it refused.
const faultingStore: Store = {
  createKitchen: async () => ({ status: 'created' }),
  findKitchen: async () => null,
  linesForDay: async () => [],
  openChecks: async () => [],
  append: async () => {
    throw Object.assign(new Error(`D1_ERROR near "${WORDS}" for AB`), { code: 'SQLITE_ERROR' });
  },
};

function deps(store: Store): ServerDeps {
  return {
    store,
    clock: { now: () => Date.UTC(2026, 9, 20, 15, 0) },
    kitchen: { id: 'k', kind: 'scratch', label: null, timeZone: 'America/Chicago', dayStart: '04:00', createdAt: 0 },
    rules: RULES,
    rulesVersion: RULES_VERSION,
    profile: DEMO_PROFILE,
    limits: STORE_LIMITS,
    rowsPerWrite: ROWS_PER_WRITE,
  };
}

async function callWithConsoleCaptured(store: Store) {
  const handler = createMcpHandler(() => createServer(deps(store)));
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: async (url, init) => {
      const request = new Request(url, init);
      const headers = new Headers(request.headers);
      headers.set('host', 'localhost');
      return handler.fetch(new Request(request, { headers }));
    },
  });
  const client = new Client({ name: 'fault', version: '1.0.0' }, { capabilities: {} });
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'log_reading',
      arguments: {
        check_point: 'walk_in',
        value: 38,
        words: WORDS,
        initials: 'AB',
        screen_id: 'wall',
        request_id: crypto.randomUUID(),
      },
    });
    return { result, logged: JSON.stringify(logged) };
  } finally {
    console.error = original;
    await client.close();
  }
}

describe('the log_reading fault path', () => {
  it('answers a fault with the fixed sentence and logs only its name and code, never the words or initials', async () => {
    const { result, logged } = await callWithConsoleCaptured(faultingStore);

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Tolsey could not log that. Try again.' }],
    });
    expect(logged).toBe(JSON.stringify([['[log_reading]', { name: 'Error', code: 'SQLITE_ERROR' }]]));
    expect(JSON.stringify(result)).not.toMatch(/walk-in|reads|AB|D1_ERROR/);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { builtWorkerHarness } from '../test-support/target';

const UNKNOWN_KITCHEN = '0123456789abcdef0123456789abcdef';

// Sent the way a browser navigation is: under a run_worker_first pattern list anything no pattern
// matches goes to the assets whatever its shape, and without a list only a navigation takes the page
// fallback, so this shape goes red under either routing when a pattern is missing.
const NAVIGATION = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
};

describe('the built Worker answers its own routes with JSON, never the page (workerd, ASSETS bound)', () => {
  let harness: ReturnType<typeof builtWorkerHarness>;
  let baseUrl: URL;

  beforeAll(async () => {
    harness = builtWorkerHarness();
    ({ url: baseUrl } = await harness.listen());
    await harness.getWorker().applyD1Migrations('DB');
  });

  afterAll(async () => {
    await harness?.close();
  });

  it.each(['/mcp/', `/mcp/k/${UNKNOWN_KITCHEN}`, '/api/kitchens', '/api/nothing'])(
    'answers a navigation-shaped GET %s with a JSON content type, never text/html',
    async (path) => {
      const response = await fetch(new URL(path, baseUrl), { headers: NAVIGATION });
      const contentType = response.headers.get('content-type') ?? '';
      await response.body?.cancel();
      expect(contentType).toMatch(/^application\/json/);
      expect(contentType).not.toMatch(/text\/html/);
    },
  );

  it('answers POST /api/nothing with a JSON 404', async () => {
    const response = await fetch(new URL('/api/nothing', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { D1Store } from '../store/d1-store';
import type { Store } from '../store/port';
import { openTestD1, type TestD1 } from '../test-support/d1';
import { gatedStore, type GatedStore } from '../test-support/gated-store';
import { callLogReading, type ToolResult } from '../test-support/mcp-client';
import { mintThroughRoute, type FetchLike } from '../test-support/target';
import { STORE_LIMITS } from './data';
import { writeWindowMs } from './kitchens';
import { createWorker, type WorkerEnv } from './worker';

const AFTERNOON = Date.parse('2026-10-20T19:00:00Z');
const SCREEN = 'retry-wall';
const RETRY_WINDOW_MS = STORE_LIMITS.retryWindowSeconds * 1000;

const SELECT_KITCHEN_EVENTS = 'SELECT kind, request_id FROM events WHERE kitchen_id = ?1 ORDER BY seq';

interface KitchenEvent {
  kind: string;
  request_id: string;
}
const FILL_BUDGET = `
INSERT INTO budget (utc_date, rows) VALUES (?1, ?2)
ON CONFLICT (utc_date) DO UPDATE SET rows = excluded.rows`;

interface Result extends ToolResult {
  _meta?: Record<string, unknown>;
}

type Args = Record<string, unknown>;

const WALK_IN_38 = { check_point: 'walk_in', value: 38, words: 'walk-in 38', initials: 'AB' };
const WALK_IN_45 = { check_point: 'walk_in', value: 45, words: 'walk-in 45', initials: 'AB' };
const WRONG_NUMBER = { words: 'wrong number', initials: 'AB' };

function promptIdOf(result: Result): string {
  const prompt = result.structuredContent?.prompt as { id: string } | undefined;
  if (!prompt) throw new Error(`expected a prompt, got ${JSON.stringify(result.structuredContent)}`);
  return prompt.id;
}

describe('retry-safe writes over MCP', () => {
  let d1: TestD1;
  let plain: Store;
  let current: Store;
  let instant = AFTERNOON;
  const clock = { now: () => instant };
  const worker = createWorker({ clock, storeFor: () => current });
  const baseUrl = new URL('http://localhost/');

  // A Node Request built from a URL carries no Host header, and the SDK answers 403 without one.
  const fetchInProcess: FetchLike = async (url, init) => {
    const request = new Request(url, init);
    const headers = new Headers(request.headers);
    headers.set('host', new URL(String(url)).host);
    const env: WorkerEnv = {
      ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
      ALLOWED_HOSTNAMES: 'localhost',
      DB: d1.db,
    };
    return worker.fetch(new Request(request, { headers }), env);
  };

  beforeAll(async () => {
    d1 = await openTestD1();
    plain = new D1Store(d1.db);
  });

  afterAll(async () => {
    await d1?.dispose();
  });

  beforeEach(() => {
    current = plain;
    instant = AFTERNOON;
  });

  async function kitchen(at = AFTERNOON): Promise<string> {
    instant = at;
    return (await mintThroughRoute(fetchInProcess, baseUrl)).id;
  }

  function say(kitchenId: string, args: Args, at?: number): Promise<Result> {
    if (at !== undefined) instant = at;
    return callLogReading(fetchInProcess, new URL(`/mcp/k/${kitchenId}`, baseUrl), {
      screen_id: SCREEN,
      request_id: crypto.randomUUID(),
      ...args,
    });
  }

  // Every event of the kitchen whatever its business day, since the window tests cross days.
  async function events(kitchenId: string): Promise<KitchenEvent[]> {
    return (await d1.db.prepare(SELECT_KITCHEN_EVENTS).bind(kitchenId).all<KitchenEvent>()).results;
  }

  function withRequest(stored: KitchenEvent[], requestId: string): KitchenEvent[] {
    return stored.filter((event) => event.request_id === requestId);
  }

  describe('the same call sent again', () => {
    it('returns byte-identical results for a retry in sequence and leaves one line', async () => {
      const kitchenId = await kitchen();
      const call = { ...WALK_IN_38, request_id: crypto.randomUUID() };

      const first = await say(kitchenId, call);
      const retry = await say(kitchenId, call);

      expect(JSON.stringify(retry)).toBe(JSON.stringify(first));
      expect(await events(kitchenId)).toHaveLength(1);
    });

    it('leaves one line for five concurrent copies and gives all five the same result', async () => {
      const kitchenId = await kitchen();
      const call = { ...WALK_IN_38, request_id: crypto.randomUUID() };

      const results = await Promise.all([1, 2, 3, 4, 5].map(() => say(kitchenId, call)));

      expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
      expect(results[0]?.structuredContent?.outcome).toBe('in_range');
      expect(await events(kitchenId)).toHaveLength(1);
    });

    it('refuses the same request_id with a different value as request_id_reused, writing nothing and never repeating the first verdict', async () => {
      const kitchenId = await kitchen();
      const requestId = crypto.randomUUID();
      await say(kitchenId, { ...WALK_IN_38, request_id: requestId });

      const reused = await say(kitchenId, { ...WALK_IN_38, value: 39, words: 'walk-in 39', request_id: requestId });

      expect(reused.isError).toBe(true);
      expect(reused._meta).toEqual({ error: 'request_id_reused' });
      expect(reused.content[0]?.text).toMatch(/Call again with a new request_id/);
      expect(reused.structuredContent).toBeUndefined();
      expect(JSON.stringify(reused)).not.toMatch(/in range/);
      expect(await events(kitchenId)).toHaveLength(1);
    });

    it("returns the stored result to a retry that arrives inside the retry window after the kitchen's write window closed", async () => {
      const kitchenId = await kitchen();
      const closesAt = AFTERNOON + writeWindowMs(STORE_LIMITS);
      const call = { ...WALK_IN_38, request_id: crypto.randomUUID() };
      const first = await say(kitchenId, call, closesAt - 1000);
      expect(first.isError).not.toBe(true);

      const retry = await say(kitchenId, call, closesAt + 1000);
      const fresh = await say(kitchenId, { ...WALK_IN_38 }, closesAt + 1000);

      expect(retry).toEqual(first);
      expect(fresh._meta).toEqual({ error: 'kitchen_closed' });
      expect(await events(kitchenId)).toHaveLength(1);
    });
  });

  describe('the retry window', () => {
    it('returns the stored result at exactly 120,000 ms and refuses as request_id_expired at 120,001 ms, storing nothing', async () => {
      const kitchenId = await kitchen();
      const call = { ...WALK_IN_38, request_id: crypto.randomUUID() };
      const first = await say(kitchenId, call, AFTERNOON);

      const atEdge = await say(kitchenId, call, AFTERNOON + RETRY_WINDOW_MS);
      const past = await say(kitchenId, call, AFTERNOON + RETRY_WINDOW_MS + 1);
      const later = await say(kitchenId, call, AFTERNOON + RETRY_WINDOW_MS + 500);

      expect(atEdge).toEqual(first);
      expect(past).toMatchObject({ isError: true, _meta: { error: 'request_id_expired' } });
      expect(past.content[0]?.text).toContain(`record ${String(first.structuredContent?.recordCode)}`);
      expect(later._meta).toEqual({ error: 'request_id_expired' });
      expect(await events(kitchenId)).toHaveLength(1);
    });

    it('refuses a stored held prompt and a stored "wrong number" repeated past the window as request_id_expired', async () => {
      const kitchenId = await kitchen();
      const hold = { check_point: 'walk_in', value: 38, request_id: crypto.randomUUID() };
      await say(kitchenId, hold, AFTERNOON);
      await say(kitchenId, WALK_IN_45, AFTERNOON + 1000);
      const wrong = { ...WRONG_NUMBER, request_id: crypto.randomUUID() };
      await say(kitchenId, wrong, AFTERNOON + 2000);
      const before = await events(kitchenId);

      const heldAgain = await say(kitchenId, hold, AFTERNOON + RETRY_WINDOW_MS + 1);
      const wrongAgain = await say(kitchenId, wrong, AFTERNOON + 2000 + RETRY_WINDOW_MS + 1);

      expect(heldAgain._meta).toEqual({ error: 'request_id_expired' });
      expect(wrongAgain._meta).toEqual({ error: 'request_id_expired' });
      expect(await events(kitchenId)).toHaveLength(before.length);
    });

    // Only a line carries a record code, so a receipt's expired retry names none rather than a blank one.
    it("names the line's record code in a reading's expired retry and no code in a receipt's", async () => {
      const kitchenId = await kitchen();
      const reading = { ...WALK_IN_38, request_id: crypto.randomUUID() };
      const nothingToFix = { ...WRONG_NUMBER, screen_id: 'retry-empty-wall', request_id: crypto.randomUUID() };
      const logged = await say(kitchenId, reading, AFTERNOON);
      const receipt = await say(kitchenId, nothingToFix, AFTERNOON);

      const readingAgain = await say(kitchenId, reading, AFTERNOON + RETRY_WINDOW_MS + 1);
      const receiptAgain = await say(kitchenId, nothingToFix, AFTERNOON + RETRY_WINDOW_MS + 1);

      expect(logged.structuredContent?.recordCode).toBe('261020-001');
      expect(receipt.structuredContent?.outcome).toBe('nothing_to_fix');
      expect(readingAgain.content).toEqual([
        { type: 'text', text: 'Tolsey already logged this call earlier, record 261020-001. Use a new request_id only for a new reading.' },
      ]);
      expect(receiptAgain.content).toEqual([
        { type: 'text', text: 'Tolsey already logged this call earlier. Use a new request_id only for a new reading.' },
      ]);
      expect([readingAgain._meta, receiptAgain._meta]).toEqual([{ error: 'request_id_expired' }, { error: 'request_id_expired' }]);
    });

    // Equal arguments alone never make a duplicate: the recovery both refusals point a host to logs.
    it.each([
      ['a judged reading', WALK_IN_38, 'in_range'],
      ['a refusal', { check_point: 'reach_in_1', words: 'the reach-in is fine', initials: 'AB' }, 'refused'],
      ['a held prompt', { check_point: 'walk_in', value: 38 }, 'held'],
    ])('stores %s again under a new request_id after an expired and a reused refusal', async (_label, args, outcome) => {
      const kitchenId = await kitchen();
      const requestId = crypto.randomUUID();
      const first = await say(kitchenId, { ...args, request_id: requestId }, AFTERNOON);
      const expired = await say(kitchenId, { ...args, request_id: requestId }, AFTERNOON + RETRY_WINDOW_MS + 1);
      const reused = await say(kitchenId, { ...args, words: 'the walk-in', request_id: requestId });

      const again = await say(kitchenId, args);

      expect(first.structuredContent?.outcome).toBe(outcome);
      expect(expired._meta).toEqual({ error: 'request_id_expired' });
      expect(reused._meta).toEqual({ error: 'request_id_reused' });
      expect(again.structuredContent?.outcome).toBe(outcome);
      expect(await events(kitchenId)).toHaveLength(2);
    });
  });

  describe('a retry of a call that decided against state it changed', () => {
    it('gives a retried "wrong number" its stored held result, never the repeated question', async () => {
      const kitchenId = await kitchen();
      await say(kitchenId, WALK_IN_45);
      const wrong = { ...WRONG_NUMBER, request_id: crypto.randomUUID() };
      const first = await say(kitchenId, wrong);
      const before = await events(kitchenId);

      const retry = await say(kitchenId, wrong);

      expect(JSON.stringify(retry)).toBe(JSON.stringify(first));
      expect(first.structuredContent?.prompt).toMatchObject({ kind: 'number_after_wrong' });
      expect(await events(kitchenId)).toHaveLength(before.length);
    });

    it('gives a retried answer to who is logging its stored reading', async () => {
      const kitchenId = await kitchen();
      const promptId = promptIdOf(await say(kitchenId, { check_point: 'walk_in', value: 38 }));
      const answer = { initials: 'MR', pending_prompt_id: promptId, request_id: crypto.randomUUID() };
      const first = await say(kitchenId, answer);

      const retry = await say(kitchenId, answer);

      expect(JSON.stringify(retry)).toBe(JSON.stringify(first));
      expect(first.structuredContent).toMatchObject({ outcome: 'in_range', initials: 'MR' });
    });

    // Review consensus item 5: without its receipt the retry would find the 45 and open a correction.
    it('gives a retried nothing_to_fix its stored reply after a reading from the same screen lands between', async () => {
      const kitchenId = await kitchen();
      const wrong = { ...WRONG_NUMBER, request_id: crypto.randomUUID() };
      const first = await say(kitchenId, wrong);
      await say(kitchenId, WALK_IN_45);
      const before = await events(kitchenId);

      const retry = await say(kitchenId, wrong);

      expect(first.structuredContent?.outcome).toBe('nothing_to_fix');
      expect(JSON.stringify(retry)).toBe(JSON.stringify(first));
      const after = await events(kitchenId);
      expect(after).toHaveLength(before.length);
      expect(after.filter((event) => event.kind === 'wrong_number')).toHaveLength(0);
      expect(await plain.openChecks(kitchenId, '2026-10-20')).toEqual([]);
    });

    it('gives a retried repeated question its stored reply', async () => {
      const kitchenId = await kitchen();
      await say(kitchenId, WALK_IN_45);
      await say(kitchenId, WRONG_NUMBER);
      const again = { ...WRONG_NUMBER, request_id: crypto.randomUUID() };
      const first = await say(kitchenId, again);
      const before = await events(kitchenId);

      const retry = await say(kitchenId, again);

      expect(first.structuredContent?.outcome).toBe('held');
      expect(JSON.stringify(retry)).toBe(JSON.stringify(first));
      expect(await events(kitchenId)).toHaveLength(before.length);
    });

    it('gives a retried third correction "Log it by hand" its stored reply', async () => {
      const kitchenId = await kitchen();
      await say(kitchenId, WALK_IN_45);
      await say(kitchenId, { value: 40, pending_prompt_id: promptIdOf(await say(kitchenId, WRONG_NUMBER)) });
      await say(kitchenId, { value: 39, pending_prompt_id: promptIdOf(await say(kitchenId, WRONG_NUMBER)) });
      const third = { ...WRONG_NUMBER, request_id: crypto.randomUUID() };
      const first = await say(kitchenId, third);
      const before = await events(kitchenId);

      const retry = await say(kitchenId, third);

      expect(first.content[0]?.text).toBe('Log it by hand.');
      expect(JSON.stringify(retry)).toBe(JSON.stringify(first));
      expect(await events(kitchenId)).toHaveLength(before.length);
    });

    it('gives a retried already-corrected reply its stored reply', async () => {
      const kitchenId = await kitchen();
      await say(kitchenId, WALK_IN_45);
      const promptId = promptIdOf(await say(kitchenId, WRONG_NUMBER));
      await say(kitchenId, { value: 40, pending_prompt_id: promptId });
      const late = { value: 41, pending_prompt_id: promptId, request_id: crypto.randomUUID() };
      const first = await say(kitchenId, late);
      const before = await events(kitchenId);

      const retry = await say(kitchenId, late);

      expect(first.content[0]?.text).toMatch(/already corrected/);
      expect(JSON.stringify(retry)).toBe(JSON.stringify(first));
      expect(await events(kitchenId)).toHaveLength(before.length);
    });
  });

  // Fold recheck finding 2: a refusal stores nothing, so its repeat is a new attempt, which logs once
  // the budget has room again and is a retry of that line from then on.
  it('logs a demo_full call repeated after UTC midnight once, then returns that line to a further repeat', async () => {
    // Its own UTC date, since the full budget would refuse every other case's mint.
    const lateEvening = Date.parse('2026-10-22T23:00:00Z');
    const kitchenId = await kitchen(lateEvening);
    await d1.db.prepare(FILL_BUDGET).bind('2026-10-22', STORE_LIMITS.dailyRowCap).run();
    const call = { ...WALK_IN_38, request_id: crypto.randomUUID() };

    const refused = await say(kitchenId, call, Date.parse('2026-10-22T23:59:59.000Z'));
    const logged = await say(kitchenId, call, Date.parse('2026-10-23T00:00:01.000Z'));
    const repeat = await say(kitchenId, call, Date.parse('2026-10-23T00:00:02.000Z'));

    expect(refused._meta).toEqual({ error: 'demo_full' });
    expect(logged.structuredContent?.outcome).toBe('in_range');
    expect(JSON.stringify(repeat)).toBe(JSON.stringify(logged));
    expect(await events(kitchenId)).toHaveLength(1);
  });

  describe('controlled interleaving: a copy paused after its request id read while its twin completes', () => {
    // Copy A is held right after findByRequest found nothing; copy B, the same call, runs to the end.
    // A then decides against B's writes and meets the request id index on its own append.
    async function interleave(kitchenId: string, args: Args): Promise<{ paused: Result; twin: Result }> {
      const gate: GatedStore = gatedStore(plain, 'findByRequest');
      current = gate.store;
      const pausedCall = say(kitchenId, args);
      await Promise.race([
        gate.reached,
        pausedCall.then(() => {
          throw new Error('copy A was answered without reading its request id first');
        }),
      ]);
      const twin = await say(kitchenId, args);
      gate.release();
      return { paused: await pausedCall, twin };
    }

    it('gives a paused "wrong number" its twin\'s stored result, leaving one wrong_number event and no receipt', async () => {
      const kitchenId = await kitchen();
      await say(kitchenId, WALK_IN_45);
      const wrong = { ...WRONG_NUMBER, request_id: crypto.randomUUID() };

      const { paused, twin } = await interleave(kitchenId, wrong);

      expect(JSON.stringify(paused)).toBe(JSON.stringify(twin));
      const stored = await events(kitchenId);
      expect(withRequest(stored, wrong.request_id)).toHaveLength(1);
      expect(stored.filter((event) => event.kind === 'wrong_number')).toHaveLength(1);
      expect(stored.filter((event) => event.kind === 'receipt')).toHaveLength(0);
    });

    it('gives a paused answer to a correction its twin\'s stored line, leaving one superseding line', async () => {
      const kitchenId = await kitchen();
      await say(kitchenId, WALK_IN_45);
      const promptId = promptIdOf(await say(kitchenId, WRONG_NUMBER));
      const answer = { value: 40, pending_prompt_id: promptId, request_id: crypto.randomUUID() };

      const { paused, twin } = await interleave(kitchenId, answer);

      expect(JSON.stringify(paused)).toBe(JSON.stringify(twin));
      expect(twin.structuredContent).toMatchObject({ outcome: 'in_range', value: 40 });
      const stored = await events(kitchenId);
      expect(withRequest(stored, answer.request_id)).toHaveLength(1);
      expect(stored.filter((event) => event.kind === 'reading')).toHaveLength(2);
      expect(stored.filter((event) => event.kind === 'receipt')).toHaveLength(0);
    });
  });
});

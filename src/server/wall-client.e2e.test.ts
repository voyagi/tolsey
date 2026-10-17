import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openMcpSession } from '../client/mcp-client';
import { messagesIn } from '../client/messages';
import { businessDay } from '../domain/business-day';
import { D1Store } from '../store/d1-store';
import type { D1Like, StoredLine } from '../store/port';
import { builtWorkerHarness, type FetchLike } from '../test-support/target';
import { WALL_PROFILE } from '../ui/profile';
import { createWallSession, type WallSession } from '../ui/wall-session';

const WALK_IN = 'the walk-in reads 38';
const REACH_IN_TWO = 'reach-in two is fine';
// Long enough that a mint or an initialize in workerd under a full suite never trips it, short enough
// to keep the held answer's wait small.
const LATE_ANSWER_TIMEOUT_MS = 2_000;

interface ToolCall {
  args: Record<string, unknown>;
  structuredContent: Record<string, unknown> | undefined;
}

interface SentBody {
  id?: number | string;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

// The wall also calls due_now after every answered call; only the log_reading calls are what these
// tests count and hold back.
function isLogReadingCall(sent: SentBody | undefined): boolean {
  return sent?.method === 'tools/call' && sent.params?.name === 'log_reading';
}

function openNames(session: WallSession): string[] | undefined {
  return session.getState().openChecks?.map((check) => check.name);
}

// The day is worked out here from the clock, never taken from the session or the server, so a line
// filed under any other day is a failure. A run that straddles 04:00 Chicago fails and is rerun.
function chicagoBusinessDay(): string {
  return businessDay(Date.now(), 'America/Chicago', '04:00');
}

// Reads each tools/call answer off the wire beside the session, so the test sees what the server
// said without asking the session to report it.
function recordingFetch(calls: ToolCall[]): FetchLike {
  return async (url, init) => {
    const response = await fetch(url, init);
    const sent = typeof init?.body === 'string' ? (JSON.parse(init.body) as SentBody) : undefined;
    if (sent !== undefined && isLogReadingCall(sent)) {
      const text = await response.clone().text();
      const answer = messagesIn(response.headers.get('content-type'), text).find((message) => message.id === sent.id);
      const result = answer?.result as { structuredContent?: Record<string, unknown> } | undefined;
      calls.push({ args: sent.params?.arguments ?? {}, structuredContent: result?.structuredContent });
    }
    return response;
  };
}

describe('the wall session against the built Worker in workerd, lines read straight from D1', () => {
  let harness: ReturnType<typeof builtWorkerHarness>;
  let baseUrl: URL;
  let store: D1Store;

  beforeAll(async () => {
    harness = builtWorkerHarness();
    ({ url: baseUrl } = await harness.listen());
    const worker = harness.getWorker<{ DB: D1Like }>();
    await worker.applyD1Migrations('DB');
    store = new D1Store((await worker.getEnv()).DB);
  });

  afterAll(async () => {
    await harness?.close();
  });

  describe('one session logs a reading and has a numberless check refused', () => {
    const calls: ToolCall[] = [];
    let session: WallSession;

    async function linesOfSession(day: string): Promise<StoredLine[]> {
      const kitchenId = session.kitchenId;
      if (kitchenId === null) throw new Error('the session minted no kitchen');
      return store.linesForDay(kitchenId, day);
    }

    it('starts ready at protocol 2025-11-25 with log_reading and due_now listed', async () => {
      session = createWallSession({ baseUrl, profile: WALL_PROFILE, fetch: recordingFetch(calls) });
      await session.start();

      expect(session.getState().phase).toBe('ready');
      expect(session.protocolVersion).toBe('2025-11-25');
      expect(session.toolNames).toContain('log_reading');
      expect(session.toolNames).toContain('due_now');
      expect(session.kitchenId).toMatch(/^[0-9a-f]{32}$/);
      expect(session.getState().openChecks).toEqual([]);
    });

    it('stores "the walk-in reads 38" as one in-range walk-in line by AB, the words sent unchanged', async () => {
      const day = chicagoBusinessDay();
      await session.say(WALK_IN);

      expect(calls).toHaveLength(1);
      expect(calls[0].structuredContent?.businessDay).toBe(day);
      expect(calls[0].args.words).toBe(WALK_IN);

      const lines = await linesOfSession(day);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        kind: 'reading',
        checkPointId: 'walk_in',
        valueTenths: 380,
        initials: 'AB',
        outcome: 'in_range',
        words: WALK_IN,
      });

      expect(session.getState().pass).toMatchObject({
        checkPoint: { id: 'walk_in' },
        value: 38,
        outcome: 'in_range',
      });
    });

    it('stores "reach-in two is fine" as a refusal with no value, and the pass still shows the walk-in', async () => {
      const day = chicagoBusinessDay();
      await session.say(REACH_IN_TWO);

      expect(calls).toHaveLength(2);
      expect(calls[1].structuredContent?.businessDay).toBe(day);
      expect(calls[1].structuredContent?.outcome).toBe('refused');

      const lines = await linesOfSession(day);
      expect(lines).toHaveLength(2);
      const refusal = lines.find((line) => line.kind === 'refusal');
      expect(refusal).toMatchObject({ checkPointId: 'reach_in_2', valueTenths: null, words: REACH_IN_TWO });

      expect(session.getState().pass).toMatchObject({ checkPoint: { id: 'walk_in' }, value: 38 });
    });
  });

  describe('the step a edges, each in a fresh session', () => {
    async function startedSession(calls: ToolCall[]): Promise<WallSession> {
      const session = createWallSession({ baseUrl, profile: WALL_PROFILE, fetch: recordingFetch(calls) });
      await session.start();
      return session;
    }

    it('sends "walk-in 41.45" with no value and stores no reading line for that request', async () => {
      const day = chicagoBusinessDay();
      const calls: ToolCall[] = [];
      const session = await startedSession(calls);
      await session.say('walk-in 41.45');

      expect(calls).toHaveLength(1);
      expect(calls[0].args).not.toHaveProperty('value');
      expect(calls[0].args.words).toBe('walk-in 41.45');
      const lines = await store.linesForDay(session.kitchenId as string, day);
      const ofRequest = lines.filter((line) => line.requestId === calls[0].args.request_id);
      expect(ofRequest.length).toBeGreaterThan(0);
      expect(ofRequest.filter((line) => line.kind === 'reading')).toEqual([]);
    });

    it('holds "walk-in 15" for a digit repeat, then logs "1 5" as a walk-in reading of 15 answering it', async () => {
      const day = chicagoBusinessDay();
      const calls: ToolCall[] = [];
      const session = await startedSession(calls);
      await session.say('walk-in 15');
      expect(calls[0].structuredContent).toMatchObject({ outcome: 'held', prompt: { kind: 'digit_repeat' } });
      const promptId = (calls[0].structuredContent?.prompt as { id: string }).id;

      await session.say('1 5');
      expect(calls).toHaveLength(2);
      expect(calls[1].args).toMatchObject({ value: 15, pending_prompt_id: promptId, words: '1 5' });
      expect(calls[1].args).not.toHaveProperty('check_point');

      const lines = await store.linesForDay(session.kitchenId as string, day);
      const held = lines.find((line) => line.requestId === calls[0].args.request_id);
      const reading = lines.find((line) => line.requestId === calls[1].args.request_id);
      expect(held).toMatchObject({ kind: 'held' });
      expect(reading).toMatchObject({ kind: 'reading', checkPointId: 'walk_in', valueTenths: 150, answersId: held?.id });
    });

    it('sends "wrong number" after a reading, and the record marks that line and asks for its number again', async () => {
      const day = chicagoBusinessDay();
      const calls: ToolCall[] = [];
      const session = await startedSession(calls);
      await session.say(WALK_IN);
      await session.say('wrong number');

      expect(calls).toHaveLength(2);
      expect(calls[1].args).toMatchObject({ words: 'wrong number' });
      expect(calls[1].structuredContent).toMatchObject({ outcome: 'held', prompt: { kind: 'number_after_wrong' } });
      expect(session.getState().openPrompt).toMatchObject({ kind: 'number_after_wrong' });
      const lines = await store.linesForDay(session.kitchenId as string, day);
      const reading = lines.find((line) => line.requestId === calls[0].args.request_id);
      const marker = lines.find((line) => line.requestId === calls[1].args.request_id);
      expect(reading).toMatchObject({ kind: 'reading', checkPointId: 'walk_in' });
      expect(marker).toMatchObject({ kind: 'wrong_number', refId: reading?.id });
    });
  });

  describe('the open checks, as the record lists them (R4)', () => {
    async function startedSession(): Promise<WallSession> {
      const session = createWallSession({ baseUrl, profile: WALL_PROFILE, fetch: recordingFetch([]) });
      await session.start();
      return session;
    }

    it('puts Reach-in two on the list after "reach-in two is fine"', async () => {
      const session = await startedSession();
      await session.say(REACH_IN_TWO);

      expect(openNames(session)).toEqual(['Reach-in two']);
    });

    it('takes Reach-in two off the list once "reach-in two reads 38" is logged', async () => {
      const session = await startedSession();
      await session.say(REACH_IN_TWO);
      expect(openNames(session)).toEqual(['Reach-in two']);

      await session.say('reach-in two reads 38');

      expect(session.getState().pass).toMatchObject({ checkPoint: { id: 'reach_in_2' }, value: 38 });
      expect(openNames(session)).toEqual([]);
    });

    it('keeps the Walk-in on the list while "walk-in 15" waits for a digit repeat', async () => {
      const session = await startedSession();
      await session.say('walk-in 15');

      expect(session.getState().openPrompt).toMatchObject({ kind: 'digit_repeat' });
      expect(openNames(session)).toEqual(['Walk-in']);
    });

    it("shows a second client's refusal on the same kitchen after the wall's next call", async () => {
      const session = await startedSession();
      const kitchenId = session.kitchenId as string;
      const second = await openMcpSession(new URL(`/mcp/k/${kitchenId}`, baseUrl), fetch);
      const refused = await second.callTool('log_reading', {
        check_point: 'soup_well',
        words: 'the soup well is fine',
        initials: 'MR',
        screen_id: 'second-client',
        request_id: crypto.randomUUID(),
      });
      expect(refused.structuredContent).toMatchObject({ outcome: 'refused' });
      expect(openNames(session)).toEqual([]);

      await session.say(WALK_IN);

      expect(openNames(session)).toEqual(['Soup well']);
    });
  });

  describe('who is logging and a call answered too late (R5, R6)', () => {
    it('a switch from AB to MR puts MR on the next stored line', async () => {
      const day = chicagoBusinessDay();
      const calls: ToolCall[] = [];
      const session = createWallSession({ baseUrl, profile: WALL_PROFILE, fetch: recordingFetch(calls) });
      await session.start();
      await session.say(WALK_IN);
      session.selectCook('MR');
      await session.say('the walk-in reads 37');

      expect(calls).toHaveLength(2);
      const readings = (await store.linesForDay(session.kitchenId as string, day))
        .filter((line) => line.kind === 'reading')
        .sort((left, right) => left.seq - right.seq);
      expect(readings.map((line) => line.initials)).toEqual(['AB', 'MR']);
      expect(readings.at(-1)).toMatchObject({ requestId: calls[1].args.request_id, valueTenths: 370, initials: 'MR' });
    });

    it('a call the Worker stored but answered after the timeout shows NOT LOGGED, and the same words resent store one line', async () => {
      const day = chicagoBusinessDay();
      const calls: ToolCall[] = [];
      const recording = recordingFetch(calls);
      let held = false;
      // Lets the first tools/call reach the Worker and be stored, then keeps its answer back until the
      // session gives up, as a dropped connection would.
      const answeredTooLate: FetchLike = async (url, init) => {
        const sent = typeof init?.body === 'string' ? (JSON.parse(init.body) as SentBody) : undefined;
        if (!isLogReadingCall(sent) || held) return recording(url, init);
        held = true;
        const { signal, ...unsignalled }: RequestInit = init ?? {};
        await recording(url, unsignalled);
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
          if (signal?.aborted) abort();
          signal?.addEventListener('abort', abort, { once: true });
        });
      };
      const session = createWallSession({ baseUrl, profile: WALL_PROFILE, fetch: answeredTooLate, timeoutMs: LATE_ANSWER_TIMEOUT_MS });
      await session.start();

      await session.say(WALK_IN);
      expect(session.getState().notLogged).not.toBeNull();
      expect(session.getState().pass).toBeNull();
      expect(session.getState().draft).toBe(WALK_IN);

      await session.say(WALK_IN);
      expect(calls).toHaveLength(2);
      expect(calls[1].args.request_id).toBe(calls[0].args.request_id);
      const lines = await store.linesForDay(session.kitchenId as string, day);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ requestId: calls[0].args.request_id, kind: 'reading', valueTenths: 380 });
      expect(session.getState().notLogged).toBeNull();
      expect(session.getState().pass).toMatchObject({ checkPoint: { id: 'walk_in' }, value: 38, outcome: 'in_range' });
    });
  });

  it('gives two sessions started one after the other two kitchens, each holding only its own line', async () => {
    const day = chicagoBusinessDay();
    const sessions: { session: WallSession; calls: ToolCall[] }[] = [];
    for (let started = 0; started < 2; started += 1) {
      const calls: ToolCall[] = [];
      const session = createWallSession({ baseUrl, profile: WALL_PROFILE, fetch: recordingFetch(calls) });
      await session.start();
      await session.say(WALK_IN);
      sessions.push({ session, calls });
    }

    const [first, second] = sessions;
    expect(first.session.kitchenId).not.toBeNull();
    expect(second.session.kitchenId).not.toBeNull();
    expect(first.session.kitchenId).not.toBe(second.session.kitchenId);

    for (const { session, calls } of sessions) {
      expect(calls).toHaveLength(1);
      const lines = await store.linesForDay(session.kitchenId as string, day);
      expect(lines.map((line) => line.requestId)).toEqual([calls[0].args.request_id]);
    }
    expect(first.calls[0].args.request_id).not.toBe(second.calls[0].args.request_id);
  });
});

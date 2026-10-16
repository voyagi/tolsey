import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { messagesIn } from '../client/messages';
import { businessDay } from '../domain/business-day';
import { D1Store } from '../store/d1-store';
import type { D1Like, StoredLine } from '../store/port';
import { builtWorkerHarness, type FetchLike } from '../test-support/target';
import { WALL_PROFILE } from '../ui/profile';
import { createWallSession, type WallSession } from '../ui/wall-session';

const WALK_IN = 'the walk-in reads 38';
const REACH_IN_TWO = 'reach-in two is fine';

interface ToolCall {
  args: Record<string, unknown>;
  structuredContent: Record<string, unknown> | undefined;
}

interface SentBody {
  id?: number | string;
  method?: string;
  params?: { arguments?: Record<string, unknown> };
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
    if (sent?.method === 'tools/call') {
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

    it('starts ready at protocol 2025-11-25 with log_reading listed', async () => {
      session = createWallSession({ baseUrl, profile: WALL_PROFILE, fetch: recordingFetch(calls) });
      await session.start();

      expect(session.getState().phase).toBe('ready');
      expect(session.protocolVersion).toBe('2025-11-25');
      expect(session.toolNames).toContain('log_reading');
      expect(session.kitchenId).toMatch(/^[0-9a-f]{32}$/);
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
});

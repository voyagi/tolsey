import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D1Store } from '../store/d1-store';
import type { AppendInput, AppendOutcome, Store, StoredLine } from '../store/port';
import { barrierStore } from '../test-support/barrier-store';
import { openTestD1, type TestD1 } from '../test-support/d1';
import { callLogReading, type ToolResult } from '../test-support/mcp-client';
import { mintThroughRoute, openInProcessWorker, type InProcessWorker } from '../test-support/target';
import { utcDate } from './budget';
import { DEMO_PROFILE, ROWS_PER_WRITE, RULES, RULES_VERSION, STORE_LIMITS } from './data';
import { createServer, type ServerDeps } from './mcp';

const AFTERNOON = Date.parse('2026-10-20T19:00:00Z');
const DAY = '2026-10-20';
const SCREEN = 'prompt-wall';
const ALREADY_ANSWERED = /already answered/;

interface Prompt {
  kind: string;
  id: string;
}

function promptOf(result: ToolResult): Prompt {
  const prompt = result.structuredContent?.prompt as Prompt | undefined;
  if (!prompt) throw new Error(`expected a prompt, got ${JSON.stringify(result.structuredContent)}`);
  return prompt;
}

function ofKind(stored: StoredLine[], kind: StoredLine['kind']): StoredLine[] {
  return stored.filter((line) => line.kind === kind);
}

describe('pending prompts answered in separate requests, and initials from the roster', () => {
  let worker: InProcessWorker;

  beforeAll(async () => {
    worker = await openInProcessWorker();
    worker.clock.set(AFTERNOON);
  });

  afterAll(async () => {
    await worker?.dispose();
  });

  async function kitchen(): Promise<string> {
    worker.clock.set(AFTERNOON);
    return (await mintThroughRoute(worker.fetch, worker.baseUrl)).id;
  }

  function say(kitchenId: string, args: Record<string, unknown>): Promise<ToolResult> {
    return callLogReading(worker.fetch, new URL(`/mcp/k/${kitchenId}`, worker.baseUrl), {
      screen_id: SCREEN,
      request_id: crypto.randomUUID(),
      ...args,
    });
  }

  function lines(kitchenId: string): Promise<StoredLine[]> {
    return worker.store.linesForDay(kitchenId, DAY);
  }

  describe('who_is_logging', () => {
    it('holds a reading with no initials, then logs it for the initials sent in answer', async () => {
      const kitchenId = await kitchen();
      const held = await say(kitchenId, { check_point: 'walk_in', value: 38 });
      expect(held.content[0]?.text).toBe('Who is logging?');
      const prompt = promptOf(held);
      expect(prompt.kind).toBe('who_is_logging');

      const logged = await say(kitchenId, { initials: 'MR', pending_prompt_id: prompt.id });

      expect(logged.structuredContent).toMatchObject({ outcome: 'in_range', value: 38, initials: 'MR' });
      const readings = ofKind(await lines(kitchenId), 'reading');
      expect(readings).toEqual([expect.objectContaining({ initials: 'MR', valueTenths: 380, answersId: prompt.id })]);
    });

    // The answer's own words are read: the number said again with a hedge is never logged as the held one.
    it('refuses an answer that says the held number again with a hedge, and keeps the check open', async () => {
      const kitchenId = await kitchen();
      const prompt = promptOf(await say(kitchenId, { check_point: 'walk_in', value: 38 }));

      const refused = await say(kitchenId, { initials: 'MR', value: 38, words: 'MR, about 38', pending_prompt_id: prompt.id });

      expect(refused.structuredContent).toMatchObject({ outcome: 'refused', initials: 'MR' });
      expect(promptOf(refused).kind).toBe('number');
      const stored = await lines(kitchenId);
      expect(ofKind(stored, 'reading')).toHaveLength(0);
      expect(ofKind(stored, 'refusal')).toEqual([expect.objectContaining({ checkPointId: 'walk_in', answersId: prompt.id })]);
      expect(await worker.store.openChecks(kitchenId, DAY)).toEqual(['walk_in']);
    });

    it('logs the held reading for an answer that says the same number again plainly', async () => {
      const kitchenId = await kitchen();
      const prompt = promptOf(await say(kitchenId, { check_point: 'walk_in', value: 38 }));

      const logged = await say(kitchenId, { initials: 'MR', value: 38, words: 'MR, 38', pending_prompt_id: prompt.id });

      expect(logged.structuredContent).toMatchObject({ outcome: 'in_range', value: 38, initials: 'MR' });
      expect(ofKind(await lines(kitchenId), 'reading')).toEqual([expect.objectContaining({ valueTenths: 380, answersId: prompt.id })]);
    });

    // A host may send the answer's words with no value beside them; they are read all the same.
    it('refuses an answer with no value whose words hedge the held number', async () => {
      const kitchenId = await kitchen();
      const prompt = promptOf(await say(kitchenId, { check_point: 'walk_in', value: 38 }));

      const refused = await say(kitchenId, { initials: 'MR', words: 'MR, about 38', pending_prompt_id: prompt.id });

      expect(refused.structuredContent).toMatchObject({ outcome: 'refused', initials: 'MR' });
      expect(ofKind(await lines(kitchenId), 'reading')).toHaveLength(0);
      expect(await worker.store.openChecks(kitchenId, DAY)).toEqual(['walk_in']);
    });

    it('reads a sign in the answer: "5 below" beside a held freezer 5 logs -5 for the freezer, answering the prompt', async () => {
      const kitchenId = await kitchen();
      const prompt = promptOf(await say(kitchenId, { check_point: 'freezer', value: 5 }));

      const logged = await say(kitchenId, { initials: 'MR', words: 'MR, 5 below', pending_prompt_id: prompt.id });

      expect(logged.structuredContent).toMatchObject({ outcome: 'in_range', value: -5, initials: 'MR', checkPoint: { id: 'freezer' } });
      expect(ofKind(await lines(kitchenId), 'reading')).toEqual([
        expect.objectContaining({ checkPointId: 'freezer', valueTenths: -50, answersId: prompt.id }),
      ]);
    });

    // The same word check as a fresh call: a figure said again with no sign is not a held -5.
    it('refuses an answer that says a held freezer -5 again as a plain 5, and keeps the check open', async () => {
      const kitchenId = await kitchen();
      const prompt = promptOf(await say(kitchenId, { check_point: 'freezer', value: 5, words: 'minus 5' }));
      expect(prompt.kind).toBe('who_is_logging');

      const refused = await say(kitchenId, { initials: 'MR', words: 'MR, 5', pending_prompt_id: prompt.id });

      expect(refused.structuredContent).toMatchObject({ outcome: 'refused', initials: 'MR' });
      expect(ofKind(await lines(kitchenId), 'reading')).toHaveLength(0);
      expect(await worker.store.openChecks(kitchenId, DAY)).toEqual(['freezer']);
    });

    // A state word answers the question, never the reading: the number was said and held already.
    it('logs the held reading for an answer whose words say only a state', async () => {
      const kitchenId = await kitchen();
      const prompt = promptOf(await say(kitchenId, { check_point: 'walk_in', value: 38 }));

      const logged = await say(kitchenId, { initials: 'MR', words: "MR, it's fine", pending_prompt_id: prompt.id });

      expect(logged.structuredContent).toMatchObject({ outcome: 'in_range', value: 38, initials: 'MR' });
    });
  });

  describe('number', () => {
    it('logs a number sent in answer to a refused reach-in, under the initials the refusal holds', async () => {
      const kitchenId = await kitchen();
      const refused = await say(kitchenId, { check_point: 'reach_in_1', words: 'the reach-in is fine', initials: 'AB' });
      const prompt = promptOf(refused);
      expect(prompt.kind).toBe('number');

      const logged = await say(kitchenId, { value: 39, pending_prompt_id: prompt.id });

      expect(logged.structuredContent).toMatchObject({ outcome: 'in_range', value: 39, initials: 'AB' });
      expect(ofKind(await lines(kitchenId), 'reading')).toEqual([
        expect.objectContaining({ checkPointId: 'reach_in_1', valueTenths: 390, answersId: prompt.id }),
      ]);
      expect(await worker.store.openChecks(kitchenId, DAY)).toEqual([]);
    });

    it('holds an answer of 15 to a refused walk-in for a digit repeat, never logging it unrepeated', async () => {
      const kitchenId = await kitchen();
      const refused = await say(kitchenId, { check_point: 'walk_in', words: 'the walk-in is fine', initials: 'AB' });
      const prompt = promptOf(refused);

      const held = await say(kitchenId, { value: 15, pending_prompt_id: prompt.id });

      expect(promptOf(held).kind).toBe('digit_repeat');
      const stored = await lines(kitchenId);
      expect(ofKind(stored, 'reading')).toHaveLength(0);
      expect(ofKind(stored, 'held')).toEqual([expect.objectContaining({ valueTenths: 150, answersId: prompt.id })]);
    });
  });

  describe('which_check', () => {
    it('asks "Which check reads 39?" for a bare number and logs it where the answer says', async () => {
      const kitchenId = await kitchen();
      const held = await say(kitchenId, { value: 39, initials: 'AB' });
      expect(held.content[0]?.text).toBe('Which check reads 39?');
      const prompt = promptOf(held);
      expect(prompt.kind).toBe('which_check');

      const logged = await say(kitchenId, { check_point: 'walk_in', pending_prompt_id: prompt.id });

      expect(logged.structuredContent).toMatchObject({ outcome: 'in_range', value: 39, checkPoint: { id: 'walk_in' } });
      expect(ofKind(await lines(kitchenId), 'reading')[0]?.answersId).toBe(prompt.id);
    });

    it('refuses an answer naming the check whose words give the number as a range, even one said in words', async () => {
      const kitchenId = await kitchen();
      const prompt = promptOf(await say(kitchenId, { value: 39, initials: 'AB' }));

      const refused = await say(kitchenId, {
        check_point: 'walk_in',
        value: 39,
        words: 'the walk-in, thirty nine or forty',
        pending_prompt_id: prompt.id,
      });

      expect(refused.structuredContent).toMatchObject({ outcome: 'refused', checkPoint: { id: 'walk_in' } });
      expect(ofKind(await lines(kitchenId), 'reading')).toHaveLength(0);
    });

    it('asks which check first, then who is logging, and logs after both answers', async () => {
      const kitchenId = await kitchen();
      const first = await say(kitchenId, { value: 39 });
      expect(first.content[0]?.text).toBe('Which check reads 39?');

      const second = await say(kitchenId, { check_point: 'walk_in', pending_prompt_id: promptOf(first).id });
      expect(second.content[0]?.text).toBe('Who is logging?');

      const logged = await say(kitchenId, { initials: 'JT', pending_prompt_id: promptOf(second).id });

      expect(logged.structuredContent).toMatchObject({ outcome: 'in_range', value: 39, initials: 'JT' });
      const stored = await lines(kitchenId);
      expect(ofKind(stored, 'held').map((line) => line.promptKind)).toEqual(['which_check', 'who_is_logging']);
      expect(ofKind(stored, 'held').map((line) => line.outcome)).toEqual(['held', 'held']);
      expect(ofKind(stored, 'held')[1]?.answersId).toBe(promptOf(first).id);
      expect(ofKind(stored, 'reading')[0]?.answersId).toBe(promptOf(second).id);
    });
  });

  describe('digit_repeat', () => {
    async function heldFifteen(kitchenId: string): Promise<Prompt> {
      return promptOf(await say(kitchenId, { check_point: 'walk_in', value: 15, initials: 'AB' }));
    }

    it('logs and judges a repeat equal to the held number', async () => {
      const kitchenId = await kitchen();
      const prompt = await heldFifteen(kitchenId);

      const logged = await say(kitchenId, { value: 15, pending_prompt_id: prompt.id });

      expect(logged.structuredContent).toMatchObject({ outcome: 'in_range', value: 15 });
      expect(ofKind(await lines(kitchenId), 'reading')[0]?.answersId).toBe(prompt.id);
    });

    it('holds 50 again after 15, then logs 50 out of range when it is repeated', async () => {
      const kitchenId = await kitchen();
      const prompt = await heldFifteen(kitchenId);

      const again = await say(kitchenId, { value: 50, pending_prompt_id: prompt.id });
      expect(promptOf(again).kind).toBe('digit_repeat');
      const logged = await say(kitchenId, { value: 50, pending_prompt_id: promptOf(again).id });

      expect(logged.structuredContent).toMatchObject({ outcome: 'out_of_range', value: 50 });
      const held = ofKind(await lines(kitchenId), 'held');
      expect(held[1]).toMatchObject({ answersId: prompt.id, refId: prompt.id, valueTenths: 500 });
    });

    it('answers a third different number "Log it by hand", closes the prompt with a receipt and keeps the check open', async () => {
      const kitchenId = await kitchen();
      const first = await heldFifteen(kitchenId);
      const second = promptOf(await say(kitchenId, { value: 51, pending_prompt_id: first.id }));
      const third = promptOf(await say(kitchenId, { value: 16, pending_prompt_id: second.id }));
      const byHandArgs = { value: 61, pending_prompt_id: third.id, request_id: crypto.randomUUID() };

      const byHand = await say(kitchenId, byHandArgs);

      expect(byHand.isError).not.toBe(true);
      expect(byHand.content[0]?.text).toBe('Log it by hand.');
      expect(byHand.structuredContent?.outcome).toBe('refused');
      expect(byHand.structuredContent).not.toHaveProperty('prompt');
      expect(byHand.structuredContent).not.toHaveProperty('lineId');
      let stored = await lines(kitchenId);
      expect(ofKind(stored, 'receipt')).toEqual([
        expect.objectContaining({ answersId: third.id, refId: first.id, dayLine: null }),
      ]);
      expect(ofKind(stored, 'reading')).toHaveLength(0);
      expect(await worker.store.openChecks(kitchenId, DAY)).toEqual(['walk_in']);

      const late = await say(kitchenId, { value: 16, pending_prompt_id: third.id });
      expect(late.content[0]?.text).toMatch(ALREADY_ANSWERED);
      expect(late.structuredContent?.outcome).toBe('refused');
      stored = await lines(kitchenId);
      expect(ofKind(stored, 'receipt')).toHaveLength(2);
      expect(ofKind(stored, 'reading')).toHaveLength(0);
      expect(await worker.store.openChecks(kitchenId, DAY)).toEqual(['walk_in']);

      const retry = await say(kitchenId, byHandArgs);
      expect(retry).toEqual(byHand);
      expect(await lines(kitchenId)).toHaveLength(stored.length);
    });

    // A numberless answer is a miss too, and the refusal it stores stays on the chain, so a number
    // sent in answer to that refusal is held on the same count rather than starting a new one.
    it('carries the chain through a numberless answer, so a third miss still ends it "Log it by hand"', async () => {
      const kitchenId = await kitchen();
      const first = await heldFifteen(kitchenId);
      const refused = promptOf(await say(kitchenId, { words: 'the walk-in is fine', pending_prompt_id: first.id }));
      expect(refused.kind).toBe('number');
      const again = promptOf(await say(kitchenId, { value: 15, pending_prompt_id: refused.id }));
      expect(again.kind).toBe('digit_repeat');

      const byHand = await say(kitchenId, { value: 51, pending_prompt_id: again.id });

      expect(byHand.content[0]?.text).toBe('Log it by hand.');
      const stored = await lines(kitchenId);
      expect(ofKind(stored, 'refusal')).toEqual([expect.objectContaining({ answersId: first.id, refId: first.id })]);
      expect(ofKind(stored, 'held')[1]).toMatchObject({ answersId: refused.id, refId: first.id });
      expect(ofKind(stored, 'receipt')).toEqual([expect.objectContaining({ answersId: again.id, refId: first.id })]);
      expect(await worker.store.openChecks(kitchenId, DAY)).toEqual(['walk_in']);
    });

    it('ends the chain "Log it by hand" on a third miss that gives no number', async () => {
      const kitchenId = await kitchen();
      const first = await heldFifteen(kitchenId);
      const refused = promptOf(await say(kitchenId, { words: 'the walk-in is fine', pending_prompt_id: first.id }));
      const again = promptOf(await say(kitchenId, { value: 15, pending_prompt_id: refused.id }));

      const byHand = await say(kitchenId, { words: 'the walk-in is fine', pending_prompt_id: again.id });

      expect(byHand.content[0]?.text).toBe('Log it by hand.');
      expect(byHand.structuredContent).not.toHaveProperty('prompt');
      const stored = await lines(kitchenId);
      expect(ofKind(stored, 'refusal')).toHaveLength(1);
      expect(ofKind(stored, 'receipt')).toEqual([expect.objectContaining({ answersId: again.id, refId: first.id })]);
      expect(await worker.store.openChecks(kitchenId, DAY)).toEqual(['walk_in']);
    });

    it('never confirms the held number with a yes on its own', async () => {
      const kitchenId = await kitchen();
      const prompt = await heldFifteen(kitchenId);

      const yes = await say(kitchenId, { words: 'yes', pending_prompt_id: prompt.id });

      expect(yes.structuredContent?.outcome).not.toMatch(/in_range|out_of_range/);
      expect(ofKind(await lines(kitchenId), 'reading')).toHaveLength(0);
      expect(await worker.store.openChecks(kitchenId, DAY)).toEqual(['walk_in']);
    });
  });

  describe('answers that are not answers', () => {
    it('logs a new number said with the initials as a fresh call and leaves the held 38 unanswered', async () => {
      const kitchenId = await kitchen();
      const prompt = promptOf(await say(kitchenId, { check_point: 'walk_in', value: 38 }));

      const logged = await say(kitchenId, { check_point: 'walk_in', value: 40, initials: 'MR', pending_prompt_id: prompt.id });

      expect(logged.structuredContent).toMatchObject({ outcome: 'in_range', value: 40, initials: 'MR' });
      expect(ofKind(await lines(kitchenId), 'reading')[0]?.answersId).toBeNull();
      expect((await worker.store.pendingPrompt(kitchenId, prompt.id))?.answered).toBe(false);
    });

    it('logs a walk-in number sent in answer to a reach-in question as a walk-in call, leaving the reach-in open', async () => {
      const kitchenId = await kitchen();
      const refused = await say(kitchenId, { check_point: 'reach_in_1', words: 'the reach-in is fine', initials: 'AB' });

      await say(kitchenId, { check_point: 'walk_in', value: 38, initials: 'AB', pending_prompt_id: promptOf(refused).id });

      expect(await worker.store.openChecks(kitchenId, DAY)).toEqual(['reach_in_1']);
    });

    it('leaves a prompt unanswered by an answer from another screen', async () => {
      const kitchenId = await kitchen();
      const prompt = promptOf(await say(kitchenId, { check_point: 'walk_in', value: 38 }));

      await say(kitchenId, { initials: 'MR', pending_prompt_id: prompt.id, screen_id: 'other-wall' });

      expect(ofKind(await lines(kitchenId), 'reading')).toHaveLength(0);
      expect((await worker.store.pendingPrompt(kitchenId, prompt.id))?.answered).toBe(false);
    });

    it('treats an answer after the prompt expired as a bare number with nothing pending (E24)', async () => {
      const kitchenId = await kitchen();
      const refused = await say(kitchenId, { check_point: 'reach_in_1', words: 'the reach-in is fine', initials: 'AB' });
      worker.clock.set(AFTERNOON + (DEMO_PROFILE.promptExpirySeconds + 1) * 1000);

      const late = await say(kitchenId, { value: 39, initials: 'AB', pending_prompt_id: promptOf(refused).id });

      expect(late.content[0]?.text).toBe('Which check reads 39?');
      expect(await worker.store.openChecks(kitchenId, DAY)).toEqual(['reach_in_1']);
    });

    it('treats an id naming no prompt, or a logged line, as a bare number, never a server fault', async () => {
      const kitchenId = await kitchen();
      const reading = await say(kitchenId, { check_point: 'walk_in', value: 38, initials: 'AB' });
      const lineId = reading.structuredContent?.lineId as string;

      for (const pendingPromptId of ['no-such-prompt', lineId]) {
        const result = await say(kitchenId, { value: 39, initials: 'AB', pending_prompt_id: pendingPromptId });
        expect(result.isError).not.toBe(true);
        expect(result.content[0]?.text).toBe('Which check reads 39?');
      }
    });
  });

  describe('a prompt is answered once', () => {
    it('gives a later second answer the already-answered reply and one receipt, never a second line', async () => {
      const kitchenId = await kitchen();
      const prompt = promptOf(await say(kitchenId, { check_point: 'walk_in', value: 38 }));
      await say(kitchenId, { initials: 'MR', pending_prompt_id: prompt.id });

      const second = await say(kitchenId, { initials: 'MR', pending_prompt_id: prompt.id });

      expect(second.isError).not.toBe(true);
      expect(second.content[0]?.text).toMatch(ALREADY_ANSWERED);
      expect(second.structuredContent?.outcome).toBe('refused');
      const stored = await lines(kitchenId);
      expect(ofKind(stored, 'reading')).toHaveLength(1);
      expect(ofKind(stored, 'receipt')).toEqual([expect.objectContaining({ answersId: null, initials: 'MR' })]);
    });

    // A retry is decided again against a prompt its own first delivery changed: answered, or by now
    // expired though still inside the retry window, which starts at the answer. Only the stored request
    // id stands between that new decision and the cook's reply.
    it("gives a retried answer its own stored reading once the prompt reads answered, never the already-answered reply", async () => {
      const kitchenId = await kitchen();
      const prompt = promptOf(await say(kitchenId, { check_point: 'walk_in', value: 38 }));
      const answer = { initials: 'MR', pending_prompt_id: prompt.id, request_id: crypto.randomUUID() };
      const first = await say(kitchenId, answer);
      const before = await lines(kitchenId);

      const retry = await say(kitchenId, answer);

      expect(retry).toEqual(first);
      expect(first.structuredContent).toMatchObject({ outcome: 'in_range', initials: 'MR' });
      expect(await lines(kitchenId)).toHaveLength(before.length);
    });

    it('gives a retried answer its own stored reading after the prompt expired inside the retry window', async () => {
      const kitchenId = await kitchen();
      const prompt = promptOf(await say(kitchenId, { check_point: 'walk_in', value: 38 }));
      const answeredAt = AFTERNOON + (DEMO_PROFILE.promptExpirySeconds - 10) * 1000;
      const retriedAt = AFTERNOON + (DEMO_PROFILE.promptExpirySeconds + 10) * 1000;
      expect(retriedAt - answeredAt).toBeLessThan(STORE_LIMITS.retryWindowSeconds * 1000);
      const answer = { initials: 'MR', pending_prompt_id: prompt.id, request_id: crypto.randomUUID() };
      worker.clock.set(answeredAt);
      const first = await say(kitchenId, answer);
      const before = await lines(kitchenId);

      worker.clock.set(retriedAt);
      const retry = await say(kitchenId, answer);

      expect(retry).toEqual(first);
      expect(first.structuredContent).toMatchObject({ outcome: 'in_range', initials: 'MR' });
      expect(await lines(kitchenId)).toHaveLength(before.length);
    });

    it('leaves one answering line when two answers race over HTTP, and the other gets the already-answered reply', async () => {
      const kitchenId = await kitchen();
      const prompt = promptOf(await say(kitchenId, { check_point: 'walk_in', value: 38 }));

      const results = await Promise.all([
        say(kitchenId, { initials: 'MR', pending_prompt_id: prompt.id }),
        say(kitchenId, { initials: 'JT', pending_prompt_id: prompt.id }),
      ]);

      const stored = await lines(kitchenId);
      expect(stored.filter((line) => line.answersId === prompt.id)).toHaveLength(1);
      expect(ofKind(stored, 'receipt')).toHaveLength(1);
      expect(results.filter((result) => ALREADY_ANSWERED.test(result.content[0]?.text ?? ''))).toHaveLength(1);
    });
  });

  describe('initials from the roster only', () => {
    it('refuses initials ZZ with the named error and stores nothing', async () => {
      const kitchenId = await kitchen();
      const result = await say(kitchenId, { check_point: 'walk_in', value: 38, initials: 'ZZ' });

      expect(result).toMatchObject({
        isError: true,
        content: [
          {
            type: 'text',
            text: "Those initials are not on this kitchen's roster. Who is logging? Call again with the whole reading and their initials.",
          },
        ],
        _meta: { error: 'initials_not_on_roster' },
      });
      expect(await lines(kitchenId)).toHaveLength(0);
    });

    it('refuses ZZ on a numberless reach-in with the roster error and never a refusal line', async () => {
      const kitchenId = await kitchen();
      const result = await say(kitchenId, { check_point: 'reach_in_1', words: 'the reach-in is fine', initials: 'ZZ' });

      expect(result).toMatchObject({ isError: true, _meta: { error: 'initials_not_on_roster' } });
      expect(await lines(kitchenId)).toHaveLength(0);
    });

    it.each(['ab', 'A.B.', 'a b'])('logs initials sent as "%s" in the roster form AB', async (initials) => {
      const kitchenId = await kitchen();
      const result = await say(kitchenId, { check_point: 'walk_in', value: 38, initials });

      expect(result.structuredContent?.initials).toBe('AB');
      expect(ofKind(await lines(kitchenId), 'reading')[0]?.initials).toBe('AB');
    });

    // Dropping a letter outside A to Z would turn another person's initials into a roster entry. The
    // accented E is built from its code point so this file stays plain ASCII.
    it.each([`${String.fromCodePoint(0xc9)}AB`, `${String.fromCodePoint(0xe9)}.a.b.`])('refuses initials sent as "%s" rather than reading them as AB', async (initials) => {
      const kitchenId = await kitchen();
      const result = await say(kitchenId, { check_point: 'walk_in', value: 38, initials });

      expect(result).toMatchObject({ isError: true, _meta: { error: 'initials_not_on_roster' } });
      expect(await lines(kitchenId)).toHaveLength(0);
    });
  });
});

// The race is forced here: both calls read the prompt as unanswered before either writes, so the
// loser reaches the answers index, never the already-answered read.
describe('two answers that both read the prompt before either writes', () => {
  const KITCHEN_ID = 'race-kitchen';
  let d1: TestD1;
  let store: D1Store;

  beforeAll(async () => {
    d1 = await openTestD1();
    store = new D1Store(d1.db);
    await store.createKitchen({
      kitchen: { id: KITCHEN_ID, kind: 'scratch', label: null, timeZone: 'America/Chicago', dayStart: '04:00', createdAt: AFTERNOON },
      expectedRows: ROWS_PER_WRITE.kitchen_create,
      utcDate: utcDate(AFTERNOON),
      dailyRowCap: STORE_LIMITS.dailyRowCap,
    });
  });

  afterAll(async () => {
    await d1?.dispose();
  });

  function depsFor(backing: Store): ServerDeps {
    return {
      store: backing,
      clock: { now: () => AFTERNOON },
      kitchen: { id: KITCHEN_ID, kind: 'scratch', label: null, timeZone: 'America/Chicago', dayStart: '04:00', createdAt: AFTERNOON },
      rules: RULES,
      rulesVersion: RULES_VERSION,
      profile: DEMO_PROFILE,
      limits: STORE_LIMITS,
      rowsPerWrite: ROWS_PER_WRITE,
    };
  }

  async function callThrough(backing: Store, args: Record<string, unknown>): Promise<ToolResult> {
    const handler = createMcpHandler(() => createServer(depsFor(backing)));
    const client = new Client({ name: 'race', version: '1.0.0' }, { capabilities: {} });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
        fetch: async (url, init) => {
          const request = new Request(url, init);
          const headers = new Headers(request.headers);
          headers.set('host', 'localhost');
          return handler.fetch(new Request(request, { headers }));
        },
      }),
    );
    try {
      return (await client.callTool({ name: 'log_reading', arguments: args })) as ToolResult;
    } finally {
      await client.close();
    }
  }

  async function heldPrompt(): Promise<Prompt> {
    return promptOf(await callThrough(store, { check_point: 'walk_in', value: 38, screen_id: SCREEN, request_id: crypto.randomUUID() }));
  }

  it('stores one answering line, and the loser gets the already-answered reply with one receipt of its own', async () => {
    const prompt = await heldPrompt();
    const racing = barrierStore(store, 2);
    const answer = (initials: string) => ({ initials, pending_prompt_id: prompt.id, screen_id: SCREEN, request_id: crypto.randomUUID() });

    const results = await Promise.all([callThrough(racing, answer('MR')), callThrough(racing, answer('JT'))]);

    const stored = await store.linesForDay(KITCHEN_ID, DAY);
    expect(stored.filter((line) => line.answersId === prompt.id)).toHaveLength(1);
    const losers = results.filter((result) => ALREADY_ANSWERED.test(result.content[0]?.text ?? ''));
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ structuredContent: { outcome: 'refused' } });
    expect(losers[0]?.isError).not.toBe(true);
    const receipts = ofKind(stored, 'receipt').filter((line) => line.initials === losers[0]?.structuredContent?.initials);
    expect(receipts).toEqual([expect.objectContaining({ answersId: null })]);
  });

  it("gives a concurrent retry of the winner's own request id the winner's stored result, never a second line", async () => {
    const prompt = await heldPrompt();
    const racing = barrierStore(store, 2);
    const args = { initials: 'KL', pending_prompt_id: prompt.id, screen_id: SCREEN, request_id: crypto.randomUUID() };
    const before = (await store.linesForDay(KITCHEN_ID, DAY)).length;

    const [first, retry] = await Promise.all([callThrough(racing, args), callThrough(racing, args)]);

    expect(retry).toEqual(first);
    expect(first.structuredContent).toMatchObject({ outcome: 'in_range', initials: 'KL' });
    expect(await store.linesForDay(KITCHEN_ID, DAY)).toHaveLength(before + 1);
  });

  it("answers the loser with the refusal of its own receipt's append, storing nothing, when that append is refused", async () => {
    const prompt = await heldPrompt();
    const appended: AppendInput[] = [];
    const stub = Object.assign(Object.create(store) as Store, {
      append: async (input: AppendInput): Promise<AppendOutcome> => {
        appended.push(input);
        return input.event.answersId === null
          ? { status: 'refused', reason: 'kitchen_full' }
          : { status: 'conflict', constraint: 'answers' };
      },
    });
    const before = (await store.linesForDay(KITCHEN_ID, DAY)).length;

    const result = await callThrough(stub, { initials: 'MR', pending_prompt_id: prompt.id, screen_id: SCREEN, request_id: crypto.randomUUID() });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'This kitchen is full. Start a new kitchen to keep logging.' }],
      _meta: { error: 'kitchen_full' },
    });
    expect(JSON.stringify(result)).not.toMatch(ALREADY_ANSWERED);
    expect(appended.map((input) => input.event.kind)).toEqual(['reading', 'receipt']);
    expect(await store.linesForDay(KITCHEN_ID, DAY)).toHaveLength(before);
  });
});

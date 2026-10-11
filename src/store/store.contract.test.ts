import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeWindowMs } from '../server/kitchens';
import { openTestD1 } from '../test-support/d1';
import {
  appendInput,
  KITCHEN_CREATED_AT,
  kitchenInput,
  readLimits,
  RESULT_TEMPLATE,
  scratchKitchen,
  testEvent,
} from '../test-support/events';
import { D1Store } from './d1-store';
import { MemoryStore } from './memory-store';
import { SUPERSEDE_WALK_LINKS, type AppendInput, type AppendOutcome, type NewEvent, type Store } from './port';

const limits = readLimits();
const DAY = '2026-10-20';
const AT = KITCHEN_CREATED_AT + 60_000;
const RETRY_WINDOW_MS = limits.retryWindowSeconds * 1000;
const WRITE_WINDOW_MS = writeWindowMs(limits);
const PROMPT_EXPIRES_AT = AT + 120_000;

interface OpenedStore {
  store: Store;
  dispose(): Promise<void>;
}

interface Leg {
  name: string;
  open(): Promise<OpenedStore>;
}

const LEGS: Leg[] = [
  { name: 'MemoryStore', open: async () => ({ store: new MemoryStore(), dispose: async () => {} }) },
  {
    name: 'D1Store',
    open: async () => {
      const d1 = await openTestD1();
      return { store: new D1Store(d1.db), dispose: d1.dispose };
    },
  },
];

type Appended = Extract<AppendOutcome, { status: 'appended' }>;

function recordCodeOf(resultJson: string): string | undefined {
  return (JSON.parse(resultJson) as { structuredContent?: { recordCode?: string } }).structuredContent?.recordCode;
}

function prompt(kitchenId: string, overrides: Partial<NewEvent> = {}): NewEvent {
  return testEvent(kitchenId, {
    kind: 'held',
    valueTenths: 380,
    outcome: 'held',
    verdict: null,
    ruleId: null,
    promptKind: 'who_is_logging',
    expiresAt: PROMPT_EXPIRES_AT,
    ...overrides,
  });
}

function receipt(kitchenId: string, overrides: Partial<NewEvent> = {}): NewEvent {
  return testEvent(kitchenId, { kind: 'receipt', valueTenths: null, unit: null, verdict: null, ruleId: null, ...overrides });
}

describe.each(LEGS)('the store contract on $name', (leg) => {
  let opened: OpenedStore;
  let store: Store;

  beforeAll(async () => {
    opened = await leg.open();
    store = opened.store;
  });

  afterAll(async () => {
    await opened?.dispose();
  });

  async function kitchen(): Promise<string> {
    const row = scratchKitchen();
    expect(await store.createKitchen(kitchenInput(row, limits))).toEqual({ status: 'created' });
    return row.id;
  }

  function append(event: NewEvent, overrides: Partial<AppendInput> = {}): Promise<AppendOutcome> {
    return store.append(appendInput(event, limits, overrides));
  }

  async function appended(event: NewEvent, overrides: Partial<AppendInput> = {}): Promise<Appended> {
    const outcome = await append(event, overrides);
    if (outcome.status !== 'appended') throw new Error(`expected appended, got ${JSON.stringify(outcome)}`);
    return outcome;
  }

  describe('kitchens', () => {
    it('creates a kitchen and finds it as created', async () => {
      const row = scratchKitchen();

      expect(await store.createKitchen(kitchenInput(row, limits))).toEqual({ status: 'created' });
      expect(await store.findKitchen(row.id)).toEqual(row);
      expect(await store.findKitchen('no-such-kitchen')).toBeNull();
    });

    it('refuses a kitchen past the daily budget and creates nothing', async () => {
      const row = scratchKitchen();

      expect(await store.createKitchen(kitchenInput(row, limits, { dailyRowCap: 10 }))).toEqual({ status: 'refused', reason: 'budget_full' });
      expect(await store.findKitchen(row.id)).toBeNull();
    });

    it('refuses a second kitchen under an id already taken and keeps the first as created', async () => {
      const row = scratchKitchen();
      expect(await store.createKitchen(kitchenInput(row, limits))).toEqual({ status: 'created' });

      await expect(store.createKitchen(kitchenInput({ ...row, label: 'capture' }, limits))).rejects.toThrow(
        /UNIQUE constraint failed: kitchens\.id/,
      );
      expect(await store.findKitchen(row.id)).toEqual(row);
    });
  });

  describe('lines and record codes', () => {
    it('numbers readings and refusals by day line, and gives holds, corrections and receipts neither a line nor a code', async () => {
      const kitchenId = await kitchen();
      const reading = await appended(testEvent(kitchenId));
      const held = await appended(prompt(kitchenId));
      const said = await appended(prompt(kitchenId, { kind: 'wrong_number', promptKind: 'number_after_wrong', valueTenths: null }));
      const kept = await appended(receipt(kitchenId));
      const refusal = await appended(testEvent(kitchenId, { kind: 'refusal', valueTenths: null, promptKind: 'number', expiresAt: PROMPT_EXPIRES_AT }));

      expect([reading, held, said, kept, refusal].map((outcome) => outcome.dayLine)).toEqual([1, null, null, null, 2]);
      expect([reading, refusal].map((outcome) => recordCodeOf(outcome.resultJson))).toEqual(['261020-001', '261020-002']);
      expect([held, said, kept].map((outcome) => outcome.resultJson)).toEqual([RESULT_TEMPLATE, RESULT_TEMPLATE, RESULT_TEMPLATE]);
      const seqs = [reading, held, said, kept, refusal].map((outcome) => outcome.seq);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      expect(new Set(seqs).size).toBe(5);
    });

    it('returns a day in seq order with every stored field', async () => {
      const kitchenId = await kitchen();
      const first = testEvent(kitchenId, { ruleSnapshot: '{"id":"unit_air_cold"}' });
      const firstOutcome = await appended(first);
      const second = receipt(kitchenId);
      const secondOutcome = await appended(second);

      expect(await store.linesForDay(kitchenId, DAY)).toEqual([
        { ...first, seq: firstOutcome.seq, dayLine: 1, resultJson: firstOutcome.resultJson },
        { ...second, seq: secondOutcome.seq, dayLine: null, resultJson: RESULT_TEMPLATE },
      ]);
      expect(await store.linesForDay(kitchenId, '2026-10-21')).toEqual([]);
    });
  });

  describe('a request id already stored', () => {
    it('finds the stored call by its request id, and nothing for an id never used', async () => {
      const kitchenId = await kitchen();
      const event = testEvent(kitchenId, { requestId: 'find-1' });
      const outcome = await appended(event);

      expect(await store.findByRequest(kitchenId, 'find-1')).toEqual({
        argsHash: event.argsHash,
        occurredAt: event.occurredAt,
        resultJson: outcome.resultJson,
      });
      expect(await store.findByRequest(kitchenId, 'never-used')).toBeNull();
      expect(await store.findByRequest('another-kitchen', 'find-1')).toBeNull();
    });

    it.each(['reading', 'receipt'] as const)('answers a repeated %s request id as duplicate, reused or expired, writing nothing', async (kind) => {
      const kitchenId = await kitchen();
      const make = (overrides: Partial<NewEvent>) => (kind === 'receipt' ? receipt(kitchenId, overrides) : testEvent(kitchenId, overrides));
      const first = await appended(make({ requestId: 'repeat-1' }));

      expect(await append(make({ requestId: 'repeat-1' }))).toEqual({ status: 'duplicate', resultJson: first.resultJson });
      expect(await append(make({ requestId: 'repeat-1', argsHash: 'args-b' }))).toEqual({ status: 'reused' });
      expect(await append(make({ requestId: 'repeat-1', occurredAt: AT + RETRY_WINDOW_MS }))).toEqual({
        status: 'duplicate',
        resultJson: first.resultJson,
      });
      expect(await append(make({ requestId: 'repeat-1', occurredAt: AT + RETRY_WINDOW_MS + 1 }))).toEqual({
        status: 'expired',
        resultJson: first.resultJson,
      });
      expect(await store.linesForDay(kitchenId, DAY)).toHaveLength(1);
    });

    it('returns the stored result to a repeat inside the retry window after the write window closed', async () => {
      const kitchenId = await kitchen();
      const lateAt = KITCHEN_CREATED_AT + WRITE_WINDOW_MS - 30_000;
      const first = await appended(testEvent(kitchenId, { requestId: 'late-1', occurredAt: lateAt }));

      const repeat = testEvent(kitchenId, { requestId: 'late-1', occurredAt: lateAt + 60_000 });
      expect(await append(repeat)).toEqual({ status: 'duplicate', resultJson: first.resultJson });
      expect(await append(testEvent(kitchenId, { occurredAt: lateAt + 60_000 }))).toEqual({ status: 'refused', reason: 'kitchen_closed' });
    });
  });

  describe('refusals', () => {
    it('refuses kitchen_closed before kitchen_full before budget_full, writing nothing', async () => {
      const kitchenId = await kitchen();
      await appended(testEvent(kitchenId));
      const closed = testEvent(kitchenId, { requestId: 'closed-1' });

      expect(await append(closed, { now: KITCHEN_CREATED_AT + WRITE_WINDOW_MS, kitchenLineCap: 1, dailyRowCap: 0 })).toEqual({
        status: 'refused',
        reason: 'kitchen_closed',
      });
      expect(await append(testEvent(kitchenId), { kitchenLineCap: 1, dailyRowCap: 0 })).toEqual({ status: 'refused', reason: 'kitchen_full' });
      expect(await append(testEvent(kitchenId), { dailyRowCap: 10 })).toEqual({ status: 'refused', reason: 'budget_full' });
      expect(await store.findByRequest(kitchenId, 'closed-1')).toBeNull();
      expect(await store.linesForDay(kitchenId, DAY)).toHaveLength(1);
    });

    it('accepts a write 1 ms inside the write window', async () => {
      const kitchenId = await kitchen();

      expect((await append(testEvent(kitchenId), { now: KITCHEN_CREATED_AT + WRITE_WINDOW_MS - 1 })).status).toBe('appended');
    });

    it('refuses a write to the demo kitchen as kitchen_closed', async () => {
      expect(await append(testEvent('demo'))).toEqual({ status: 'refused', reason: 'kitchen_closed' });
      expect(await store.findByRequest('demo', 'any')).toBeNull();
    });
  });

  describe('supersede once and answer once', () => {
    it('returns conflict supersedes when only supersedes_id collides, writing nothing', async () => {
      const kitchenId = await kitchen();
      const line = await testLine(kitchenId);
      await appended(testEvent(kitchenId, { supersedesId: line, rootId: line, answersId: crypto.randomUUID() }));

      expect(await append(testEvent(kitchenId, { supersedesId: line, rootId: line, answersId: crypto.randomUUID() }))).toEqual({
        status: 'conflict',
        constraint: 'supersedes',
      });
      expect(await store.linesForDay(kitchenId, DAY)).toHaveLength(2);
    });

    it('returns conflict answers when only answers_id collides, writing nothing', async () => {
      const kitchenId = await kitchen();
      const asked = prompt(kitchenId);
      await appended(asked);
      await appended(testEvent(kitchenId, { answersId: asked.id }));

      expect(await append(receipt(kitchenId, { answersId: asked.id }))).toEqual({ status: 'conflict', constraint: 'answers' });
      expect(await store.linesForDay(kitchenId, DAY)).toHaveLength(2);
    });

    // SQLite names one of the two indexes in an order the adapter does not depend on, so only the
    // status is part of the contract.
    it('returns conflict for an event colliding on both indexes', async () => {
      const kitchenId = await kitchen();
      const line = await testLine(kitchenId);
      const asked = prompt(kitchenId, { kind: 'wrong_number', promptKind: 'number_after_wrong', refId: line });
      await appended(asked);
      await appended(testEvent(kitchenId, { supersedesId: line, rootId: line, answersId: asked.id }));

      const outcome = await append(testEvent(kitchenId, { supersedesId: line, rootId: line, answersId: asked.id }));

      expect(outcome.status).toBe('conflict');
    });

    it('rethrows a collision on the opaque event id', async () => {
      const kitchenId = await kitchen();
      const event = testEvent(kitchenId);
      await appended(event);

      await expect(append({ ...event, requestId: 'another-request' })).rejects.toThrow(/UNIQUE/);
    });

    async function testLine(kitchenId: string): Promise<string> {
      const line = testEvent(kitchenId);
      await appended(line);
      return line.id;
    }
  });

  describe('open checks', () => {
    it('keeps a check open while its newest event asks for a number, and leaves receipts out', async () => {
      const kitchenId = await kitchen();
      const open = () => store.openChecks(kitchenId, DAY);

      await appended(testEvent(kitchenId, { kind: 'refusal', valueTenths: null, promptKind: 'number', expiresAt: PROMPT_EXPIRES_AT }));
      expect(await open()).toEqual(['walk_in']);
      const line = testEvent(kitchenId);
      await appended(line);
      expect(await open()).toEqual([]);
      await appended(prompt(kitchenId, { checkPointId: 'reach_in_1' }));
      await appended(receipt(kitchenId, { checkPointId: 'reach_in_1' }));
      expect(await open()).toEqual(['reach_in_1']);
      await appended(testEvent(kitchenId, { checkPointId: 'reach_in_1' }));
      const said = prompt(kitchenId, { kind: 'wrong_number', promptKind: 'number_after_wrong', refId: line.id });
      await appended(said);
      await appended(receipt(kitchenId));
      expect(await open()).toEqual(['walk_in']);
      await appended(testEvent(kitchenId, { supersedesId: line.id, rootId: line.id, answersId: said.id }));
      expect(await open()).toEqual([]);
    });
  });

  describe('pending prompts', () => {
    it('reads a prompt with its answered flag, and nothing for a line, a missing id or another kitchen', async () => {
      const kitchenId = await kitchen();
      const asked = prompt(kitchenId);
      await appended(asked);
      const line = testEvent(kitchenId);
      await appended(line);

      expect(await store.pendingPrompt(kitchenId, asked.id)).toEqual({
        id: asked.id,
        promptKind: 'who_is_logging',
        checkPointId: 'walk_in',
        measured: 'air',
        valueTenths: 380,
        initials: 'QX',
        screenId: 'wall',
        expiresAt: PROMPT_EXPIRES_AT,
        refId: null,
        answered: false,
        repeats: 0,
        supersedes: null,
      });
      await appended(receipt(kitchenId, { answersId: asked.id }));
      expect((await store.pendingPrompt(kitchenId, asked.id))?.answered).toBe(true);
      expect(await store.pendingPrompt(kitchenId, line.id)).toBeNull();
      expect(await store.pendingPrompt(kitchenId, 'no-such-prompt')).toBeNull();
      expect(await store.pendingPrompt('another-kitchen', asked.id)).toBeNull();
    });

    it('counts the digit repeats held along a chain', async () => {
      const kitchenId = await kitchen();
      const first = prompt(kitchenId, { promptKind: 'digit_repeat', valueTenths: 150 });
      await appended(first);
      const second = prompt(kitchenId, { promptKind: 'digit_repeat', valueTenths: 510, answersId: first.id, refId: first.id });
      await appended(second);

      expect((await store.pendingPrompt(kitchenId, second.id))?.repeats).toBe(1);
    });

    it('counts the misses along a chain for a refusal stored on it', async () => {
      const kitchenId = await kitchen();
      const first = prompt(kitchenId, { promptKind: 'digit_repeat', valueTenths: 150 });
      await appended(first);
      const refusal = (answersId: string) =>
        testEvent(kitchenId, { kind: 'refusal', valueTenths: null, promptKind: 'number', expiresAt: PROMPT_EXPIRES_AT, answersId, refId: first.id });
      const once = refusal(first.id);
      await appended(once);
      const twice = refusal(once.id);
      await appended(twice);

      expect((await store.pendingPrompt(kitchenId, twice.id))?.repeats).toBe(2);
    });

    // A first hold names no chain head in ref_id, so its misses are counted against its own id: never
    // against every hold that names none, which would count itself and the first hold of any other chain.
    it("counts no misses on a chain's first digit-repeat hold, whatever holds other chains have opened", async () => {
      const kitchenId = await kitchen();
      const first = prompt(kitchenId, { promptKind: 'digit_repeat', valueTenths: 150 });
      await appended(first);
      await appended(prompt(kitchenId, { promptKind: 'digit_repeat', valueTenths: 510, checkPointId: 'reach_in_1' }));

      expect(await store.pendingPrompt(kitchenId, first.id)).toMatchObject({ id: first.id, refId: null, repeats: 0 });
    });

    it('gives a question no supersede target when the line it says wrong belongs to another kitchen', async () => {
      const kitchenId = await kitchen();
      const foreign = testEvent(await kitchen());
      await appended(foreign);
      const own = testEvent(kitchenId);
      await appended(own);
      const saidForeign = prompt(kitchenId, { kind: 'wrong_number', promptKind: 'number_after_wrong', refId: foreign.id, valueTenths: null });
      await appended(saidForeign);
      const saidOwn = prompt(kitchenId, { kind: 'wrong_number', promptKind: 'number_after_wrong', refId: own.id, valueTenths: null });
      await appended(saidOwn);

      expect((await store.pendingPrompt(kitchenId, saidForeign.id))?.supersedes).toBeNull();
      expect((await store.pendingPrompt(kitchenId, saidOwn.id))?.supersedes).toMatchObject({ lineId: own.id, rootId: own.id });
    });

    it("gives every prompt of a correction's chain the line said wrong as its supersede target", async () => {
      const kitchenId = await kitchen();
      const line = testEvent(kitchenId, { ruleSnapshot: '{"id":"unit_air_cold"}', rulesVersion: 'rules-1' });
      await appended(line);
      const said = prompt(kitchenId, { kind: 'wrong_number', promptKind: 'number_after_wrong', refId: line.id, valueTenths: null });
      await appended(said);
      const who = prompt(kitchenId, { answersId: said.id, valueTenths: 400, initials: null });
      await appended(who);
      const hedged = testEvent(kitchenId, { kind: 'refusal', valueTenths: null, answersId: who.id, promptKind: 'number', expiresAt: PROMPT_EXPIRES_AT });
      await appended(hedged);
      const target = { lineId: line.id, rootId: line.id, ruleSnapshot: '{"id":"unit_air_cold"}', rulesVersion: 'rules-1', superseded: false };

      for (const id of [said.id, who.id, hedged.id]) {
        expect((await store.pendingPrompt(kitchenId, id))?.supersedes).toEqual(target);
      }
      const unrelated = prompt(kitchenId);
      await appended(unrelated);
      expect((await store.pendingPrompt(kitchenId, unrelated.id))?.supersedes).toBeNull();
      await appended(testEvent(kitchenId, { supersedesId: line.id, rootId: line.id, answersId: hedged.id }));
      for (const id of [said.id, who.id, hedged.id]) {
        expect((await store.pendingPrompt(kitchenId, id))?.supersedes).toEqual({ ...target, superseded: true });
      }
    });

    it('names the chain root as the target root of a correction corrected again', async () => {
      const kitchenId = await kitchen();
      const root = testEvent(kitchenId);
      await appended(root);
      const second = testEvent(kitchenId, { supersedesId: root.id, rootId: root.id });
      await appended(second);
      const said = prompt(kitchenId, { kind: 'wrong_number', promptKind: 'number_after_wrong', refId: second.id });
      await appended(said);

      expect((await store.pendingPrompt(kitchenId, said.id))?.supersedes).toMatchObject({ lineId: second.id, rootId: root.id });
    });

    // A numberless answer to a correction's question is a refusal answering it, with no limit on how
    // many follow, so the walk back to the wrong_number event follows SUPERSEDE_WALK_LINKS links at most.
    it.each([
      ['finds the line said wrong at the last link the walk follows', SUPERSEDE_WALK_LINKS, true],
      ['finds no line one link past the walk bound', SUPERSEDE_WALK_LINKS + 1, false],
    ])('%s', async (_label, links, found) => {
      const kitchenId = await kitchen();
      const line = testEvent(kitchenId);
      await appended(line);
      let last = prompt(kitchenId, { kind: 'wrong_number', promptKind: 'number_after_wrong', refId: line.id, valueTenths: null });
      await appended(last);
      for (let link = 0; link < links; link++) {
        last = testEvent(kitchenId, { kind: 'refusal', valueTenths: null, promptKind: 'number', expiresAt: PROMPT_EXPIRES_AT, answersId: last.id });
        await appended(last);
      }

      const supersedes = (await store.pendingPrompt(kitchenId, last.id))?.supersedes;

      if (found) expect(supersedes).toMatchObject({ lineId: line.id, rootId: line.id, superseded: false });
      else expect(supersedes).toBeNull();
    });
  });

  describe("a screen's newest event", () => {
    it('reads the newest event this screen wrote inside the window, receipts left out, with its chain corrections', async () => {
      const kitchenId = await kitchen();
      const latest = (since = AT) => store.latestByScreen(kitchenId, 'wall-a', since);
      const first = testEvent(kitchenId, { screenId: 'wall-a' });
      await appended(first);

      expect(await latest()).toMatchObject({ id: first.id, kind: 'reading', corrections: 0, answered: false });
      expect(await latest(AT + 1)).toBeNull();
      expect(await store.latestByScreen(kitchenId, 'wall-b', AT)).toBeNull();
      await appended(receipt(kitchenId, { screenId: 'wall-a', occurredAt: AT + 1000 }));
      expect((await latest())?.id).toBe(first.id);

      const said = prompt(kitchenId, { screenId: 'wall-a', kind: 'wrong_number', promptKind: 'number_after_wrong', refId: first.id, valueTenths: null, occurredAt: AT + 2000 });
      await appended(said);
      expect(await latest()).toEqual({
        id: said.id,
        kind: 'wrong_number',
        occurredAt: AT + 2000,
        checkPointId: 'walk_in',
        measured: 'air',
        valueTenths: null,
        promptKind: 'number_after_wrong',
        expiresAt: PROMPT_EXPIRES_AT,
        answered: false,
        corrections: 0,
      });
      const second = testEvent(kitchenId, { screenId: 'wall-a', supersedesId: first.id, rootId: first.id, answersId: said.id, occurredAt: AT + 3000 });
      await appended(second);
      expect(await latest()).toMatchObject({ id: second.id, corrections: 1 });
      const again = prompt(kitchenId, { screenId: 'wall-a', kind: 'wrong_number', promptKind: 'number_after_wrong', refId: second.id, occurredAt: AT + 4000 });
      await appended(again);
      const third = testEvent(kitchenId, { screenId: 'wall-a', supersedesId: second.id, rootId: first.id, answersId: again.id, occurredAt: AT + 5000 });
      await appended(third);
      expect(await latest()).toMatchObject({ id: third.id, corrections: 2 });
    });

    // Two "wrong number" calls that both read the line before either wrote leave two questions about
    // it, yet the line was said wrong once: corrections counts lines said wrong, never questions asked.
    it('counts a line two questions said wrong as one correction', async () => {
      const kitchenId = await kitchen();
      const first = testEvent(kitchenId, { screenId: 'wall-c' });
      await appended(first);
      const said = (occurredAt: number) =>
        prompt(kitchenId, { screenId: 'wall-c', kind: 'wrong_number', promptKind: 'number_after_wrong', refId: first.id, valueTenths: null, occurredAt });
      const one = said(AT + 1000);
      await appended(one);
      await appended(said(AT + 1001));
      await appended(testEvent(kitchenId, { screenId: 'wall-c', supersedesId: first.id, rootId: first.id, answersId: one.id, occurredAt: AT + 2000 }));

      expect(await store.latestByScreen(kitchenId, 'wall-c', AT)).toMatchObject({ kind: 'reading', corrections: 1 });
    });

    // The newest event the screen wrote is picked first and the window applied to it after, so a call
    // stored later with a clock behind an earlier one is still the newest, inside the window or not.
    it('applies the window to the newest event the screen wrote, never to an older one inside it', async () => {
      const kitchenId = await kitchen();
      await appended(testEvent(kitchenId, { screenId: 'wall-i', occurredAt: AT + 5000 }));
      const later = testEvent(kitchenId, { screenId: 'wall-i', occurredAt: AT });
      await appended(later);

      expect(await store.latestByScreen(kitchenId, 'wall-i', AT + 1000)).toBeNull();
      expect(await store.latestByScreen(kitchenId, 'wall-i', AT)).toMatchObject({ id: later.id, kind: 'reading' });
    });
  });

  describe('concurrent appends', () => {
    it('numbers four concurrent appends with distinct seq and day lines, read back 1 to 4 in seq order', async () => {
      const kitchenId = await kitchen();
      const events = Array.from({ length: 4 }, () => testEvent(kitchenId));

      const outcomes = await Promise.all(events.map((event) => append(event)));

      const done = outcomes.map((outcome) => {
        if (outcome.status !== 'appended') throw new Error(`expected appended, got ${JSON.stringify(outcome)}`);
        return outcome;
      });
      expect(new Set(done.map((outcome) => outcome.seq)).size).toBe(4);
      expect(new Set(done.map((outcome) => outcome.dayLine)).size).toBe(4);
      const read = await store.linesForDay(kitchenId, DAY);
      expect(read.map((line) => line.id).sort()).toEqual(events.map((event) => event.id).sort());
      expect(read.map((line) => line.dayLine)).toEqual([1, 2, 3, 4]);
      expect(read.map((line) => line.seq)).toEqual([...read.map((line) => line.seq)].sort((a, b) => a - b));
    });

    // Each index is proven on its own here: in a shared-prompt race both refuse, which would hide
    // either one missing.
    it('leaves one row for two concurrent events sharing only a supersedes_id', async () => {
      const kitchenId = await kitchen();
      const line = testEvent(kitchenId);
      await appended(line);

      // answers_id is unique across the whole table, so each case draws its own.
      const outcomes = await Promise.all(
        [crypto.randomUUID(), crypto.randomUUID()].map((answersId) =>
          append(testEvent(kitchenId, { supersedesId: line.id, rootId: line.id, answersId })),
        ),
      );

      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['appended', 'conflict']);
      expect(outcomes.find((outcome) => outcome.status === 'conflict')).toEqual({ status: 'conflict', constraint: 'supersedes' });
      expect((await store.linesForDay(kitchenId, DAY)).filter((stored) => stored.supersedesId === line.id)).toHaveLength(1);
    });

    it('leaves one row for two concurrent events sharing only an answers_id', async () => {
      const kitchenId = await kitchen();
      const asked = prompt(kitchenId);
      await appended(asked);

      const outcomes = await Promise.all([append(testEvent(kitchenId, { answersId: asked.id })), append(receipt(kitchenId, { answersId: asked.id }))]);

      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['appended', 'conflict']);
      expect(outcomes.find((outcome) => outcome.status === 'conflict')).toEqual({ status: 'conflict', constraint: 'answers' });
      expect((await store.linesForDay(kitchenId, DAY)).filter((stored) => stored.answersId === asked.id)).toHaveLength(1);
    });
  });
});

// The same log run through a fresh store of each kind must read back byte for byte the same, seq
// included, so a test double that drifts from the adapter fails here as well as in its own leg.
describe('one event log through both stores', () => {
  async function transcript(store: Store): Promise<unknown> {
    let next = 0;
    const id = () => `event-${++next}`;
    const row = { ...scratchKitchen(), id: 'transcript-kitchen' };
    const kitchenId = row.id;
    const outcomes: unknown[] = [await store.createKitchen(kitchenInput(row, limits))];
    const line = testEvent(kitchenId, { id: id(), requestId: 'r-1', screenId: 'wall-t' });
    const said = prompt(kitchenId, { id: id(), requestId: 'r-2', screenId: 'wall-t', kind: 'wrong_number', promptKind: 'number_after_wrong', refId: line.id });
    const who = prompt(kitchenId, { id: id(), requestId: 'r-3', screenId: 'wall-t', answersId: said.id, initials: null });
    const fixed = testEvent(kitchenId, { id: id(), requestId: 'r-4', screenId: 'wall-t', supersedesId: line.id, rootId: line.id, answersId: who.id });
    const kept = receipt(kitchenId, { id: id(), requestId: 'r-5', screenId: 'wall-t' });
    const refused = testEvent(kitchenId, { id: id(), requestId: 'r-6', kind: 'refusal', checkPointId: 'reach_in_1', valueTenths: null, promptKind: 'number', expiresAt: PROMPT_EXPIRES_AT });
    // A correction whose number is held for a digit repeat and then missed twice: the third hold finds
    // its target by walking answers_id back through both earlier holds to the wrong_number event, two
    // steps of the walk, so a walk that stops after one fails here.
    const frozen = testEvent(kitchenId, { id: id(), requestId: 'r-10', checkPointId: 'freezer', valueTenths: -50 });
    const saidFrozen = prompt(kitchenId, { id: id(), requestId: 'r-11', kind: 'wrong_number', checkPointId: 'freezer', promptKind: 'number_after_wrong', refId: frozen.id, valueTenths: null });
    const firstHold = prompt(kitchenId, { id: id(), requestId: 'r-12', checkPointId: 'freezer', promptKind: 'digit_repeat', valueTenths: -150, answersId: saidFrozen.id });
    const secondHold = prompt(kitchenId, { id: id(), requestId: 'r-13', checkPointId: 'freezer', promptKind: 'digit_repeat', valueTenths: -160, answersId: firstHold.id, refId: firstHold.id });
    const thirdHold = prompt(kitchenId, { id: id(), requestId: 'r-15', checkPointId: 'freezer', promptKind: 'digit_repeat', valueTenths: -170, answersId: secondHold.id, refId: firstHold.id });
    const nextDay = testEvent(kitchenId, { id: id(), requestId: 'r-14', businessDay: '2026-10-21' });
    for (const event of [line, said, who, fixed, kept, refused, frozen, saidFrozen, firstHold, secondHold, thirdHold, nextDay]) {
      outcomes.push(await store.append(appendInput(event, limits)));
    }
    outcomes.push(await store.append(appendInput({ ...line, id: id() }, limits)));
    outcomes.push(await store.append(appendInput({ ...line, id: id(), argsHash: 'args-z' }, limits)));
    outcomes.push(await store.append(appendInput({ ...line, id: id(), occurredAt: AT + RETRY_WINDOW_MS + 1 }, limits)));
    outcomes.push(await store.append(appendInput(testEvent(kitchenId, { id: id(), requestId: 'r-7', supersedesId: line.id }), limits)));
    outcomes.push(await store.append(appendInput(receipt(kitchenId, { id: id(), requestId: 'r-8', answersId: who.id }), limits)));
    outcomes.push(await store.append(appendInput(testEvent(kitchenId, { id: id(), requestId: 'r-9' }), limits, { kitchenLineCap: 6 })));
    return {
      outcomes,
      lines: await store.linesForDay(kitchenId, DAY),
      nextDay: await store.linesForDay(kitchenId, '2026-10-21'),
      open: await store.openChecks(kitchenId, DAY),
      prompts: await Promise.all([said.id, who.id, refused.id, thirdHold.id].map((promptId) => store.pendingPrompt(kitchenId, promptId))),
      latest: await store.latestByScreen(kitchenId, 'wall-t', AT),
      found: await Promise.all(['r-1', 'r-5', 'r-9'].map((requestId) => store.findByRequest(kitchenId, requestId))),
    };
  }

  // This test starts its own local D1 inside its body, which the default 5 s test timeout also has to
  // cover: under coverage it was measured at 5013 ms once, so it gets the time a setup hook would.
  it('reads back the same outcomes, lines, open checks, prompts, newest event and stored calls', { timeout: 20_000 }, async () => {
    const d1 = await openTestD1();
    try {
      const fromMemory = await transcript(new MemoryStore());
      const fromD1 = await transcript(new D1Store(d1.db));

      expect(fromMemory).toEqual(fromD1);
      // Equal is not enough, since both stores could be wrong the same way: the paths the log was
      // built to reach are asserted here once.
      expect(JSON.stringify(fromD1)).toContain('261020-002');
      expect(fromD1).toMatchObject({
        open: ['freezer', 'reach_in_1'],
        nextDay: [{ requestId: 'r-14', dayLine: 1 }],
        prompts: [
          { supersedes: { lineId: 'event-1', superseded: true } },
          { supersedes: { lineId: 'event-1', superseded: true } },
          { supersedes: null },
          { repeats: 2, supersedes: { lineId: 'event-7', rootId: 'event-7', superseded: false } },
        ],
      });
    } finally {
      await d1.dispose();
    }
  });
});

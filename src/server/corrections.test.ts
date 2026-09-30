import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuleRow } from '../domain/rule';
import { D1Store } from '../store/d1-store';
import type { AppendInput, AppendOutcome, PendingPrompt, Store, StoredLine } from '../store/port';
import { openTestD1, type TestD1 } from '../test-support/d1';
import { callLogReading, type ToolResult } from '../test-support/mcp-client';
import { mintThroughRoute, openInProcessWorker, type InProcessWorker } from '../test-support/target';
import { utcDate } from './budget';
import { DEMO_PROFILE, ROWS_PER_WRITE, RULES, RULES_VERSION, STORE_LIMITS } from './data';
import { createServer, type ServerDeps } from './mcp';

const AFTERNOON = Date.parse('2026-10-20T19:00:00Z');
const DAY = '2026-10-20';
const SCREEN = 'correction-wall';
const SECOND_MS = 1000;
const WALK_IN_45 = { check_point: 'walk_in', value: 45, words: 'walk-in 45', initials: 'AB' };

interface Result extends ToolResult {
  _meta?: Record<string, unknown>;
}

interface Prompt {
  kind: string;
  id: string;
}

function promptOf(result: ToolResult): Prompt {
  const prompt = result.structuredContent?.prompt as Prompt | undefined;
  if (!prompt) throw new Error(`expected a prompt, got ${JSON.stringify(result.structuredContent)}`);
  return prompt;
}

function lineIdOf(result: ToolResult): string {
  const lineId = result.structuredContent?.lineId;
  if (typeof lineId !== 'string') throw new Error(`expected a line, got ${JSON.stringify(result.structuredContent)}`);
  return lineId;
}

// The day as a count would read it: only the newest line of each chain, a line some other line names
// in supersedes_id being said wrong.
function newestLines(stored: StoredLine[]): StoredLine[] {
  const superseded = new Set(stored.map((line) => line.supersedesId).filter((id) => id !== null));
  return stored.filter((line) => (line.kind === 'reading' || line.kind === 'refusal') && !superseded.has(line.id));
}

function outcomeCounts(stored: StoredLine[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of newestLines(stored)) counts[line.outcome] = (counts[line.outcome] ?? 0) + 1;
  return counts;
}

describe('wrong number through MCP, each step its own request', () => {
  let worker: InProcessWorker;

  beforeAll(async () => {
    worker = await openInProcessWorker();
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

  async function walkInFortyFive(kitchenId: string): Promise<string> {
    const logged = await say(kitchenId, { check_point: 'walk_in', value: 45, words: 'walk-in 45', initials: 'AB' });
    expect(logged.structuredContent).toMatchObject({ outcome: 'out_of_range', value: 45 });
    return lineIdOf(logged);
  }

  async function saidWrong(kitchenId: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    worker.clock.set(AFTERNOON + 30 * SECOND_MS);
    return say(kitchenId, { words: 'wrong number', initials: 'AB', ...args });
  }

  it('asks for the walk-in again after "wrong number" and keeps the walk-in open', async () => {
    const kitchenId = await kitchen();
    await walkInFortyFive(kitchenId);

    const asked = await saidWrong(kitchenId);

    expect(asked.isError).not.toBe(true);
    expect(asked.content[0]?.text).toBe('What does the walk-in read?');
    expect(asked.structuredContent?.outcome).toBe('held');
    expect(promptOf(asked).kind).toBe('number_after_wrong');
    expect(await worker.store.openChecks(kitchenId, DAY)).toEqual(['walk_in']);
  });

  it('logs the number sent in answer as a new line superseding the 45, pointed at by the wrong_number event', async () => {
    const kitchenId = await kitchen();
    const fortyFive = await walkInFortyFive(kitchenId);
    const prompt = promptOf(await saidWrong(kitchenId));

    const corrected = await say(kitchenId, { value: 40, pending_prompt_id: prompt.id });

    expect(corrected.content[0]?.text).toBe('Walk-in, 40, in range, AB');
    expect(corrected.structuredContent).toMatchObject({ outcome: 'in_range', value: 40, supersedesLineId: fortyFive });
    const stored = await lines(kitchenId);
    expect(stored.map((line) => line.kind)).toEqual(['reading', 'wrong_number', 'reading']);
    expect(stored[1]).toMatchObject({ id: prompt.id, refId: fortyFive, checkPointId: 'walk_in', dayLine: null, outcome: 'held' });
    expect(stored[2]).toMatchObject({ valueTenths: 400, supersedesId: fortyFive, rootId: fortyFive, answersId: prompt.id });
  });

  it('leaves the 45 exactly as it was, closes the walk-in and counts only the newest line (N4)', async () => {
    const kitchenId = await kitchen();
    const fortyFive = await walkInFortyFive(kitchenId);
    const before = (await lines(kitchenId)).find((line) => line.id === fortyFive);
    const prompt = promptOf(await saidWrong(kitchenId));

    await say(kitchenId, { value: 40, pending_prompt_id: prompt.id });

    const stored = await lines(kitchenId);
    const after = stored.find((line) => line.id === fortyFive);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ valueTenths: 450, verdict: 'out of range' });
    expect(JSON.parse(after?.ruleSnapshot ?? 'null')).toMatchObject({ id: 'unit_air_cold' });
    expect(await worker.store.openChecks(kitchenId, DAY)).toEqual([]);
    expect(outcomeCounts(stored)).toEqual({ in_range: 1 });
  });

  // D-05: one call stores one event, so a number said with the phrase is not a fresh reading beside
  // the line said wrong; the cook is asked for it as after a bare "wrong number".
  it('asks again for "wrong number, it\'s 40" sent with 40 and the walk-in, and never logs that 40 as a fresh reading', async () => {
    const kitchenId = await kitchen();
    const fortyFive = await walkInFortyFive(kitchenId);

    const asked = await saidWrong(kitchenId, { words: "wrong number, it's 40", value: 40, check_point: 'walk_in' });

    expect(asked.structuredContent?.outcome).toBe('held');
    const prompt = promptOf(asked);
    expect(prompt.kind).toBe('number_after_wrong');
    expect((await lines(kitchenId)).filter((line) => line.kind === 'reading')).toHaveLength(1);

    const corrected = await say(kitchenId, { value: 40, pending_prompt_id: prompt.id });

    expect(corrected.structuredContent).toMatchObject({ outcome: 'in_range', supersedesLineId: fortyFive });
  });

  it('corrects fifty heard for fifteen: the 15 is held for a digit repeat, then logged superseding the 50', async () => {
    const kitchenId = await kitchen();
    const fifty = lineIdOf(await say(kitchenId, { check_point: 'walk_in', value: 50, words: 'walk-in 50', initials: 'AB' }));
    const asked = promptOf(await saidWrong(kitchenId));

    const held = await say(kitchenId, { value: 15, pending_prompt_id: asked.id });
    expect(promptOf(held).kind).toBe('digit_repeat');
    expect(await worker.store.openChecks(kitchenId, DAY)).toEqual(['walk_in']);
    const logged = await say(kitchenId, { value: 15, pending_prompt_id: promptOf(held).id });

    expect(logged.structuredContent).toMatchObject({ outcome: 'in_range', value: 15, supersedesLineId: fifty });
    const stored = await lines(kitchenId);
    expect(stored.filter((line) => line.supersedesId !== null)).toEqual([
      expect.objectContaining({ valueTenths: 150, supersedesId: fifty, rootId: fifty }),
    ]);
    expect(stored.filter((line) => line.kind === 'held').map((line) => line.supersedesId)).toEqual([null]);
    expect(outcomeCounts(stored)).toEqual({ in_range: 1 });
    expect(await worker.store.openChecks(kitchenId, DAY)).toEqual([]);
  });

  it('corrects fifteen heard for fifty: the confirmed 15 is superseded by a 50 logged out of range', async () => {
    const kitchenId = await kitchen();
    const held = await say(kitchenId, { check_point: 'walk_in', value: 15, words: 'walk-in 15', initials: 'AB' });
    const fifteen = lineIdOf(await say(kitchenId, { value: 15, pending_prompt_id: promptOf(held).id }));
    const asked = promptOf(await saidWrong(kitchenId));

    const logged = await say(kitchenId, { value: 50, pending_prompt_id: asked.id });

    expect(logged.structuredContent).toMatchObject({ outcome: 'out_of_range', value: 50, supersedesLineId: fifteen });
    const stored = await lines(kitchenId);
    expect(outcomeCounts(stored)).toEqual({ out_of_range: 1 });
    expect(await worker.store.openChecks(kitchenId, DAY)).toEqual([]);
  });

  it('corrects a correction: three lines, one root, and the counts follow the newest', async () => {
    const kitchenId = await kitchen();
    const fortyFive = await walkInFortyFive(kitchenId);
    const forty = lineIdOf(await say(kitchenId, { value: 40, pending_prompt_id: promptOf(await saidWrong(kitchenId)).id }));

    const fortyTwo = await say(kitchenId, { value: 42, pending_prompt_id: promptOf(await saidWrong(kitchenId)).id });

    expect(fortyTwo.structuredContent).toMatchObject({ outcome: 'out_of_range', supersedesLineId: forty });
    const readings = (await lines(kitchenId)).filter((line) => line.kind === 'reading');
    expect(readings.map((line) => [line.valueTenths, line.supersedesId, line.rootId])).toEqual([
      [450, null, null],
      [400, fortyFive, fortyFive],
      [420, forty, fortyFive],
    ]);
    expect(outcomeCounts(await lines(kitchenId))).toEqual({ out_of_range: 1 });
  });

  // N5: a line with no judging path holds no rule, so neither does its correction.
  it('stores the correction of a not-covered cooling line not covered, with no rule', async () => {
    const kitchenId = await kitchen();
    const seventy = lineIdOf(await say(kitchenId, { check_point: 'cooling', value: 70, words: 'cooling 70', initials: 'AB' }));
    const asked = await saidWrong(kitchenId);
    expect(asked.content[0]?.text).toBe('What does the cooling pan read?');

    const logged = await say(kitchenId, { value: 75, pending_prompt_id: promptOf(asked).id });

    expect(logged.content[0]?.text).toBe('Cooling, 75, not covered yet, AB');
    expect(logged.structuredContent).toMatchObject({ outcome: 'not_covered', supersedesLineId: seventy });
    expect(logged.structuredContent).not.toHaveProperty('rule');
    const line = (await lines(kitchenId)).find((stored) => stored.supersedesId === seventy);
    expect(line).toMatchObject({ ruleId: null, ruleSnapshot: null, verdict: null, valueTenths: 750 });
  });

  it('asks who is logging when neither the correction nor its number gives initials, then supersedes the 45', async () => {
    const kitchenId = await kitchen();
    const fortyFive = await walkInFortyFive(kitchenId);
    const asked = promptOf(await saidWrong(kitchenId, { initials: undefined }));

    const who = await say(kitchenId, { value: 40, pending_prompt_id: asked.id });
    expect(who.content[0]?.text).toBe('Who is logging?');
    const logged = await say(kitchenId, { initials: 'MR', pending_prompt_id: promptOf(who).id });

    expect(logged.structuredContent).toMatchObject({ outcome: 'in_range', value: 40, initials: 'MR', supersedesLineId: fortyFive });
    const stored = await lines(kitchenId);
    expect(stored.find((line) => line.kind === 'held')?.supersedesId).toBeNull();
    expect(outcomeCounts(stored).out_of_range).toBeUndefined();
  });

  it('refuses a hedged number for a correction with a number prompt, then supersedes the 45 with the number given', async () => {
    const kitchenId = await kitchen();
    const fortyFive = await walkInFortyFive(kitchenId);
    const asked = promptOf(await saidWrong(kitchenId));

    const refused = await say(kitchenId, { value: 40, words: 'about 40', pending_prompt_id: asked.id });
    expect(refused.structuredContent?.outcome).toBe('refused');
    expect(promptOf(refused).kind).toBe('number');
    const logged = await say(kitchenId, { value: 40, pending_prompt_id: promptOf(refused).id });

    expect(logged.structuredContent).toMatchObject({ outcome: 'in_range', supersedesLineId: fortyFive });
    const stored = await lines(kitchenId);
    expect(stored.find((line) => line.kind === 'refusal')?.supersedesId).toBeNull();
    expect(outcomeCounts(stored).out_of_range).toBeUndefined();
  });

  // Who is logging and which check ask for something other than the number, and their answer logs the
  // number they hold, so "wrong number" said to either must refuse that number rather than ask again.
  it('never logs a held number the cook said was wrong while Tolsey asked who is logging', async () => {
    const kitchenId = await kitchen();
    const held = await say(kitchenId, { check_point: 'walk_in', value: 38, words: 'walk-in 38' });
    expect(promptOf(held).kind).toBe('who_is_logging');

    const refused = await saidWrong(kitchenId, { initials: undefined });
    const late = await say(kitchenId, { initials: 'AB', pending_prompt_id: promptOf(held).id });

    expect(refused.content[0]?.text).toBe('I need the number on the thermometer. What does the walk-in read?');
    expect(refused.structuredContent).toMatchObject({ outcome: 'refused', checkPoint: { id: 'walk_in' }, prompt: { kind: 'number' } });
    expect(late.content[0]?.text).toMatch(/already answered/);
    expect((await lines(kitchenId)).filter((line) => line.kind === 'reading')).toHaveLength(0);
    expect(await worker.store.openChecks(kitchenId, DAY)).toEqual(['walk_in']);
    const logged = await say(kitchenId, { value: 40, initials: 'AB', pending_prompt_id: promptOf(refused).id });
    expect(logged.structuredContent).toMatchObject({ outcome: 'in_range', value: 40, initials: 'AB' });
  });

  it('never logs a held number the cook said was wrong while Tolsey asked which check', async () => {
    const kitchenId = await kitchen();
    const held = await say(kitchenId, { value: 39, words: '39', initials: 'AB' });
    expect(held.content[0]?.text).toBe('Which check reads 39?');

    const refused = await saidWrong(kitchenId);
    const late = await say(kitchenId, { check_point: 'walk_in', pending_prompt_id: promptOf(held).id });

    expect(refused.content[0]?.text).toBe('I need a check and the number on the thermometer.');
    expect(refused.structuredContent?.outcome).toBe('refused');
    expect(refused.structuredContent).not.toHaveProperty('prompt');
    expect(late.content[0]?.text).toMatch(/already answered/);
    expect((await lines(kitchenId)).filter((line) => line.kind === 'reading')).toHaveLength(0);
  });

  it('answers "wrong number" after another screen\'s line with nothing to fix, storing only its receipt (E16)', async () => {
    const kitchenId = await kitchen();
    await say(kitchenId, { check_point: 'walk_in', value: 45, words: 'walk-in 45', initials: 'AB', screen_id: 'other-wall' });

    const answered = await saidWrong(kitchenId);

    expect(answered.content[0]?.text).toBe('Nothing to fix. Say a check and its number.');
    expect(answered.structuredContent?.outcome).toBe('nothing_to_fix');
    expect((await lines(kitchenId)).map((line) => line.kind)).toEqual(['reading', 'receipt']);
    expect(await worker.store.openChecks(kitchenId, DAY)).toEqual([]);
  });

  // Fold recheck finding 5: a later second number hears what a racing one hears.
  it("tells a later second number for a correction's prompt the reading was already corrected, storing one receipt", async () => {
    const kitchenId = await kitchen();
    await walkInFortyFive(kitchenId);
    const asked = promptOf(await saidWrong(kitchenId));
    await say(kitchenId, { value: 40, pending_prompt_id: asked.id });

    const second = await say(kitchenId, { value: 42, pending_prompt_id: asked.id });

    expect(second.isError).not.toBe(true);
    expect(second.content[0]?.text).toMatch(/already corrected/);
    expect(second.structuredContent?.outcome).toBe('refused');
    const stored = await lines(kitchenId);
    expect(stored.filter((line) => line.kind === 'reading')).toHaveLength(2);
    expect(stored.filter((line) => line.kind === 'receipt')).toEqual([expect.objectContaining({ answersId: null, supersedesId: null })]);
  });
});

// Every race here is forced: both calls read the prompt before either writes, so the loser reaches
// the unique indexes, never a read that already shows the line corrected.
describe('two numbers for one correction that both read the prompt before either writes', () => {
  const KITCHEN_ID = 'correction-race';
  const CREATED_AT = AFTERNOON;
  let d1: TestD1;
  let store: D1Store;

  beforeAll(async () => {
    d1 = await openTestD1();
    store = new D1Store(d1.db);
    await store.createKitchen({
      kitchen: { id: KITCHEN_ID, kind: 'scratch', label: null, timeZone: 'America/Chicago', dayStart: '04:00', createdAt: CREATED_AT },
      expectedRows: ROWS_PER_WRITE.kitchen_create,
      utcDate: utcDate(CREATED_AT),
      dailyRowCap: STORE_LIMITS.dailyRowCap,
    });
  });

  afterAll(async () => {
    await d1?.dispose();
  });

  function depsFor(backing: Store, rules: ReadonlyMap<string, RuleRow> = RULES): ServerDeps {
    return {
      store: backing,
      clock: { now: () => AFTERNOON + 30 * SECOND_MS },
      kitchen: { id: KITCHEN_ID, kind: 'scratch', label: null, timeZone: 'America/Chicago', dayStart: '04:00', createdAt: CREATED_AT },
      rules,
      rulesVersion: RULES_VERSION,
      profile: DEMO_PROFILE,
      limits: STORE_LIMITS,
      rowsPerWrite: ROWS_PER_WRITE,
    };
  }

  async function callThrough(deps: ServerDeps, args: Record<string, unknown>): Promise<Result> {
    const handler = createMcpHandler(() => createServer(deps));
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
      return (await client.callTool({ name: 'log_reading', arguments: args })) as Result;
    } finally {
      await client.close();
    }
  }

  // Every pendingPrompt read waits until `readers` calls have read, then all of them go on.
  function barrierStore(readers: number): Store {
    let waiting: (() => void)[] = [];
    return Object.assign(Object.create(store) as Store, {
      pendingPrompt: async (kitchenId: string, promptId: string): Promise<PendingPrompt | null> => {
        const read = await store.pendingPrompt(kitchenId, promptId);
        await new Promise<void>((release) => {
          waiting.push(release);
          if (waiting.length === readers) {
            waiting.forEach((go) => go());
            waiting = [];
          }
        });
        return read;
      },
    });
  }

  // Each case speaks from its own screen, so "wrong number" finds only that case's line.
  async function correctionPrompt(screen: string, rules?: ReadonlyMap<string, RuleRow>): Promise<{ line: string; prompt: string }> {
    const deps = depsFor(store, rules);
    const logged = await callThrough(deps, { ...WALK_IN_45, screen_id: screen, request_id: crypto.randomUUID() });
    const asked = await callThrough(deps, { words: 'wrong number', initials: 'AB', screen_id: screen, request_id: crypto.randomUUID() });
    return { line: lineIdOf(logged), prompt: promptOf(asked).id };
  }

  function answer(screen: string, prompt: string, value: number) {
    return { value, pending_prompt_id: prompt, screen_id: screen, request_id: crypto.randomUUID() };
  }

  async function superseding(line: string): Promise<StoredLine[]> {
    return (await store.linesForDay(KITCHEN_ID, DAY)).filter((stored) => stored.supersedesId === line);
  }

  it('leaves one superseding line, and the loser gets the already-corrected reply with one receipt of its own (E18)', async () => {
    const screen = crypto.randomUUID();
    const { line, prompt } = await correctionPrompt(screen);
    const racing = depsFor(barrierStore(2));

    const results = await Promise.all([callThrough(racing, answer(screen, prompt, 40)), callThrough(racing, answer(screen, prompt, 39))]);

    expect(await superseding(line)).toHaveLength(1);
    const losers = results.filter((result) => /already corrected/.test(result.content[0]?.text ?? ''));
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ structuredContent: { outcome: 'refused' } });
    expect(losers[0]?.isError).not.toBe(true);
    const receipts = (await store.linesForDay(KITCHEN_ID, DAY)).filter((stored) => stored.kind === 'receipt' && stored.screenId === screen);
    expect(receipts).toEqual([expect.objectContaining({ answersId: null, supersedesId: null })]);
  });

  it("gives a concurrent retry of the winner's own request id the winner's stored result, never a second line", async () => {
    const screen = crypto.randomUUID();
    const { line, prompt } = await correctionPrompt(screen);
    const racing = depsFor(barrierStore(2));
    const args = answer(screen, prompt, 40);

    const [first, retry] = await Promise.all([callThrough(racing, args), callThrough(racing, args)]);

    expect(retry).toEqual(first);
    expect(first.structuredContent).toMatchObject({ outcome: 'in_range', supersedesLineId: line });
    expect(await superseding(line)).toHaveLength(1);
  });

  // Fold recheck finding 1: a third writer can fill the budget between the loser's two appends.
  it("answers the loser with its receipt's refusal, never the already-corrected text, when that append is refused", async () => {
    const screen = crypto.randomUUID();
    const { prompt } = await correctionPrompt(screen);
    const appended: AppendInput[] = [];
    const stub = Object.assign(Object.create(store) as Store, {
      append: async (input: AppendInput): Promise<AppendOutcome> => {
        appended.push(input);
        return input.event.supersedesId === null
          ? { status: 'refused', reason: 'budget_full' }
          : { status: 'conflict', constraint: 'supersedes' };
      },
    });

    const result = await callThrough(depsFor(stub), answer(screen, prompt, 40));

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'The demo is full for today. Try the replay.' }],
      _meta: { error: 'budget_full' },
    });
    expect(JSON.stringify(result)).not.toMatch(/already corrected/);
    expect(appended.map((input) => input.event.kind)).toEqual(['reading', 'receipt']);
  });

  it('judges a correction by the rule snapshot of the line said wrong after the rule table changed', async () => {
    const screen = crypto.randomUUID();
    const { line, prompt } = await correctionPrompt(screen);
    const original = RULES.get('unit_air_cold');
    if (original?.kind !== 'temperature') throw new Error('unit_air_cold is not a temperature row');
    const loosened = new Map(RULES);
    loosened.set(original.id, { ...original, limitFTenths: original.limitFTenths + 40 });

    const logged = await callThrough(depsFor(store, loosened), answer(screen, prompt, 44));

    expect(logged.structuredContent).toMatchObject({
      outcome: 'out_of_range',
      supersedesLineId: line,
      rule: { id: original.id, limit: original.limitFTenths / 10 },
    });
    const [stored] = await superseding(line);
    expect(JSON.parse(stored?.ruleSnapshot ?? 'null')).toEqual(original);
  });
});

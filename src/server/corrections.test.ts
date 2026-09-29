import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StoredLine } from '../store/port';
import { callLogReading, type ToolResult } from '../test-support/mcp-client';
import { mintThroughRoute, openInProcessWorker, type InProcessWorker } from '../test-support/target';

const AFTERNOON = Date.parse('2026-10-20T19:00:00Z');
const DAY = '2026-10-20';
const SCREEN = 'correction-wall';
const SECOND_MS = 1000;

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
    expect(stored[1]).toMatchObject({ id: prompt.id, refId: fortyFive, checkPointId: 'walk_in', dayLine: null });
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
});

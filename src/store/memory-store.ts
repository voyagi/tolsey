import { recordCode } from '../domain/business-day';
import {
  classifyRepeat,
  type AppendInput,
  type AppendOutcome,
  type CreateKitchenInput,
  type CreateKitchenOutcome,
  type KitchenRow,
  type PendingPrompt,
  type RefusalReason,
  type ScreenEvent,
  type Store,
  type StoredLine,
  type StoredRequest,
  type SupersedeTarget,
} from './port';

// The migration's seeded demo kitchen, so a demo write is refused here exactly as it is in D1.
const DEMO_KITCHEN: KitchenRow = {
  id: 'demo',
  kind: 'demo',
  label: null,
  timeZone: 'America/Chicago',
  dayStart: '04:00',
  createdAt: 0,
};

const OPEN_KINDS: ReadonlySet<StoredLine['kind']> = new Set(['refusal', 'held', 'wrong_number']);

function requestKey(kitchenId: string, requestId: string): string {
  return JSON.stringify([kitchenId, requestId]);
}

function copy(line: StoredLine): StoredLine {
  return { ...line };
}

function withRecordCode(resultTemplate: string, businessDay: string, dayLine: number): string {
  const result = JSON.parse(resultTemplate) as { structuredContent: Record<string, unknown> };
  result.structuredContent.recordCode = recordCode(businessDay, dayLine);
  return JSON.stringify(result);
}

/**
 * @public The Store port held in memory, for tests and harnesses; the product Worker never imports it.
 *
 * Every invariant D1Store gets from the database is held the way a database holds it: by keyed maps
 * checked at write time, never by a caller's read. The order of the checks is D1Store's: a stored
 * request id decides first, then the write window, the line cap and the budget, then the unique keys.
 */
export class MemoryStore implements Store {
  private readonly kitchens = new Map<string, KitchenRow>([[DEMO_KITCHEN.id, DEMO_KITCHEN]]);
  private readonly events: StoredLine[] = [];
  private readonly byId = new Map<string, StoredLine>();
  private readonly byRequest = new Map<string, StoredLine>();
  private readonly bySupersedes = new Map<string, StoredLine>();
  private readonly byAnswers = new Map<string, StoredLine>();
  private readonly budget = new Map<string, number>();
  // D1Store's kitchen_lines: the cap reads a kept count, never a walk over the kitchen's lines.
  private readonly lineCounts = new Map<string, number>();
  private lastSeq = 0;

  async createKitchen(input: CreateKitchenInput): Promise<CreateKitchenOutcome> {
    if (!this.budgetHasRoom(input.utcDate, input.expectedRows, input.dailyRowCap)) {
      return { status: 'refused', reason: 'budget_full' };
    }
    if (this.kitchens.has(input.kitchen.id)) throw new Error('UNIQUE constraint failed: kitchens.id');
    this.kitchens.set(input.kitchen.id, { ...input.kitchen });
    this.spend(input.utcDate, input.expectedRows);
    return { status: 'created' };
  }

  async findKitchen(id: string): Promise<KitchenRow | null> {
    const kitchen = this.kitchens.get(id);
    return kitchen ? { ...kitchen } : null;
  }

  async append(input: AppendInput): Promise<AppendOutcome> {
    const { event } = input;
    const stored = this.byRequest.get(requestKey(event.kitchenId, event.requestId));
    if (stored) return classifyRepeat(stored, event.argsHash, input.now, input.retryWindowMs);
    const refusal = this.refusalFor(input);
    if (refusal) return { status: 'refused', reason: refusal };
    if (this.byId.has(event.id)) throw new Error('UNIQUE constraint failed: events.id');
    if (event.supersedesId !== null && this.bySupersedes.has(event.supersedesId)) {
      return { status: 'conflict', constraint: 'supersedes' };
    }
    if (event.answersId !== null && this.byAnswers.has(event.answersId)) return { status: 'conflict', constraint: 'answers' };
    return this.write(input);
  }

  async linesForDay(kitchenId: string, businessDay: string): Promise<StoredLine[]> {
    return this.events.filter((line) => line.kitchenId === kitchenId && line.businessDay === businessDay).map(copy);
  }

  async openChecks(kitchenId: string, businessDay: string): Promise<string[]> {
    const newest = new Map<string, StoredLine>();
    for (const line of this.events) {
      if (line.kitchenId !== kitchenId || line.businessDay !== businessDay) continue;
      if (line.checkPointId === null || line.kind === 'receipt') continue;
      newest.set(line.checkPointId, line);
    }
    return [...newest.values()]
      .filter((line) => OPEN_KINDS.has(line.kind))
      .map((line) => line.checkPointId as string)
      .sort();
  }

  async pendingPrompt(kitchenId: string, promptId: string): Promise<PendingPrompt | null> {
    const asked = this.byId.get(promptId);
    if (!asked || asked.kitchenId !== kitchenId || asked.promptKind === null || asked.expiresAt === null) return null;
    return {
      id: asked.id,
      promptKind: asked.promptKind,
      checkPointId: asked.checkPointId,
      measured: asked.measured,
      valueTenths: asked.valueTenths,
      initials: asked.initials,
      screenId: asked.screenId,
      expiresAt: asked.expiresAt,
      refId: asked.refId,
      answered: this.byAnswers.has(asked.id),
      repeats: asked.promptKind === 'digit_repeat' ? this.repeatsOf(asked) : 0,
      supersedes: this.supersedeTargetOf(asked),
    };
  }

  async latestByScreen(kitchenId: string, screenId: string, sinceMs: number): Promise<ScreenEvent | null> {
    const newest = this.events
      .filter((line) => line.kitchenId === kitchenId && line.screenId === screenId && line.occurredAt >= sinceMs && line.kind !== 'receipt')
      .at(-1);
    if (!newest) return null;
    return {
      id: newest.id,
      kind: newest.kind as ScreenEvent['kind'],
      occurredAt: newest.occurredAt,
      checkPointId: newest.checkPointId,
      measured: newest.measured,
      valueTenths: newest.valueTenths,
      promptKind: newest.promptKind,
      expiresAt: newest.expiresAt,
      answered: this.byAnswers.has(newest.id),
      corrections: newest.kind === 'reading' ? this.correctionsOf(newest) : 0,
    };
  }

  async findByRequest(kitchenId: string, requestId: string): Promise<StoredRequest | null> {
    const stored = this.byRequest.get(requestKey(kitchenId, requestId));
    return stored ? { argsHash: stored.argsHash, occurredAt: stored.occurredAt, resultJson: stored.resultJson } : null;
  }

  private budgetHasRoom(utcDate: string, expectedRows: number, dailyRowCap: number): boolean {
    return (this.budget.get(utcDate) ?? 0) + expectedRows <= dailyRowCap;
  }

  private spend(utcDate: string, rows: number): void {
    this.budget.set(utcDate, (this.budget.get(utcDate) ?? 0) + rows);
  }

  private refusalFor(input: AppendInput): RefusalReason | null {
    const kitchen = this.kitchens.get(input.event.kitchenId);
    if (!kitchen || kitchen.kind !== 'scratch' || kitchen.createdAt + input.writeWindowMs <= input.now) return 'kitchen_closed';
    if ((this.lineCounts.get(kitchen.id) ?? 0) >= input.kitchenLineCap) return 'kitchen_full';
    return this.budgetHasRoom(input.utcDate, input.expectedRows, input.dailyRowCap) ? null : 'budget_full';
  }

  private nextDayLine(kitchenId: string, businessDay: string): number {
    const lines = this.events.filter((line) => line.kitchenId === kitchenId && line.businessDay === businessDay);
    return Math.max(0, ...lines.map((line) => line.dayLine ?? 0)) + 1;
  }

  private write(input: AppendInput): AppendOutcome {
    const { event } = input;
    const numbered = event.kind === 'reading' || event.kind === 'refusal';
    const dayLine = numbered ? this.nextDayLine(event.kitchenId, event.businessDay) : null;
    const resultJson = dayLine === null ? input.resultTemplate : withRecordCode(input.resultTemplate, event.businessDay, dayLine);
    this.lastSeq += 1;
    const line: StoredLine = { ...event, seq: this.lastSeq, dayLine, resultJson };
    this.events.push(line);
    this.byId.set(line.id, line);
    this.byRequest.set(requestKey(line.kitchenId, line.requestId), line);
    if (line.supersedesId !== null) this.bySupersedes.set(line.supersedesId, line);
    if (line.answersId !== null) this.byAnswers.set(line.answersId, line);
    this.lineCounts.set(line.kitchenId, (this.lineCounts.get(line.kitchenId) ?? 0) + 1);
    this.spend(input.utcDate, input.expectedRows);
    return { status: 'appended', seq: line.seq, dayLine, resultJson };
  }

  private repeatsOf(asked: StoredLine): number {
    const first = asked.refId ?? asked.id;
    return this.events.filter(
      (line) => line.kitchenId === asked.kitchenId && line.refId === first && line.kind === 'held' && line.promptKind === 'digit_repeat',
    ).length;
  }

  // The same walk as D1Store's: a wrong_number event names the line in ref_id; any other prompt that
  // answers something follows answers_id back until a wrong_number event, or until the chain ends.
  private supersedeTargetOf(asked: StoredLine): SupersedeTarget | null {
    let link: StoredLine | undefined = asked;
    if (asked.kind !== 'wrong_number') {
      link = asked.answersId === null ? undefined : this.inKitchen(asked.answersId, asked.kitchenId);
      while (link && link.kind !== 'wrong_number') {
        link = link.answersId === null ? undefined : this.inKitchen(link.answersId, asked.kitchenId);
      }
    }
    const target = link?.refId ? this.inKitchen(link.refId, asked.kitchenId) : undefined;
    if (!target) return null;
    return {
      lineId: target.id,
      rootId: target.rootId ?? target.id,
      ruleSnapshot: target.ruleSnapshot,
      rulesVersion: target.rulesVersion,
      superseded: this.bySupersedes.has(target.id),
    };
  }

  private inKitchen(id: string, kitchenId: string): StoredLine | undefined {
    const line = this.byId.get(id);
    return line?.kitchenId === kitchenId ? line : undefined;
  }

  // The lines of the chain said wrong, each counted once however many questions were asked about it.
  private correctionsOf(reading: StoredLine): number {
    const root = reading.rootId ?? reading.id;
    const chain = new Set(
      this.events.filter((line) => line.kitchenId === reading.kitchenId && (line.rootId ?? line.id) === root).map((line) => line.id),
    );
    const saidWrong = new Set(
      this.events
        .filter((line) => line.kitchenId === reading.kitchenId && line.kind === 'wrong_number' && line.refId !== null && chain.has(line.refId))
        .map((line) => line.refId),
    );
    return saidWrong.size;
  }
}

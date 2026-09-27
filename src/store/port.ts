// The structural subset of D1 the adapter uses, so neither the Worker program nor the Node test
// program has to see the generated D1Database global.
export interface D1ResultLike<Row = Record<string, unknown>> {
  results: Row[];
  meta: { changes: number; rows_read: number; rows_written: number; last_row_id: number };
}

export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<Row = Record<string, unknown>>(): Promise<Row | null>;
  all<Row = Record<string, unknown>>(): Promise<D1ResultLike<Row>>;
  run<Row = Record<string, unknown>>(): Promise<D1ResultLike<Row>>;
}

export interface D1Like {
  prepare(query: string): D1StatementLike;
  batch<Row = Record<string, unknown>>(statements: D1StatementLike[]): Promise<D1ResultLike<Row>[]>;
}

export type KitchenKind = 'demo' | 'scratch';
export type KitchenLabel = 'capture' | 'conformance';

export interface KitchenRow {
  id: string;
  kind: KitchenKind;
  label: KitchenLabel | null;
  timeZone: string;
  dayStart: string;
  createdAt: number;
}

export type EventKind = 'reading' | 'refusal' | 'held' | 'wrong_number' | 'receipt';

// Every events column except seq, day_line and result_json, which the INSERT itself allocates or
// completes (result_json is the result template with the record code written in).
export interface NewEvent {
  id: string;
  kitchenId: string;
  kind: EventKind;
  occurredAt: number;
  businessDay: string;
  timeZone: string;
  screenId: string;
  requestId: string;
  origin: 'person' | 'seed';
  checkPointId: string | null;
  measured: string | null;
  initials: string | null;
  words: string;
  valueTenths: number | null;
  unit: 'F' | null;
  outcome: string;
  verdict: string | null;
  ruleId: string | null;
  ruleSnapshot: string | null;
  rulesVersion: string | null;
  supersedesId: string | null;
  rootId: string | null;
  refId: string | null;
  answersId: string | null;
  promptKind: string | null;
  expiresAt: number | null;
  dueSlotId: string | null;
  dueAt: number | null;
  argsHash: string;
}

export interface StoredLine extends NewEvent {
  seq: number;
  dayLine: number | null;
  resultJson: string;
}

export interface RowsPerWrite {
  kitchen_create: number;
  event_first_of_day: number;
  event: number;
  event_superseding: number;
  event_answering: number;
  budget_add: number;
}

// The adapter cannot know before the batch runs whether the date's budget row exists yet, or which
// partial indexes the event will fill, so it reserves the worst case: a first-of-date event plus the
// measured extra of each partial index this event carries a key for.
export function expectedRowsFor(event: NewEvent, rowsPerWrite: RowsPerWrite): number {
  const supersedingExtra = event.supersedesId === null ? 0 : rowsPerWrite.event_superseding - rowsPerWrite.event;
  const answeringExtra = event.answersId === null ? 0 : rowsPerWrite.event_answering - rowsPerWrite.event;
  return rowsPerWrite.event_first_of_day + supersedingExtra + answeringExtra;
}

export interface AppendInput {
  event: NewEvent;
  resultTemplate: string;
  expectedRows: number;
  utcDate: string;
  dailyRowCap: number;
  kitchenLineCap: number;
  writeWindowMs: number;
  retryWindowMs: number;
  now: number;
}

export type RefusalReason = 'budget_full' | 'kitchen_full' | 'kitchen_closed';

// A mint spends the same daily allowance as a write, so the kitchen insert is guarded by the budget
// the same way an event append is.
export interface CreateKitchenInput {
  kitchen: KitchenRow;
  expectedRows: number;
  utcDate: string;
  dailyRowCap: number;
}

export type CreateKitchenOutcome = { status: 'created' } | { status: 'refused'; reason: 'budget_full' };

export type AppendOutcome =
  | { status: 'appended'; seq: number; dayLine: number | null; resultJson: string }
  | { status: 'duplicate'; resultJson: string }
  | { status: 'reused' }
  | { status: 'expired'; resultJson: string }
  | { status: 'refused'; reason: RefusalReason }
  | { status: 'conflict'; constraint: 'supersedes' | 'answers' };

// No method edits or removes an event: the record is append-only, and expiring a whole scratch
// kitchen is retention, which lives outside this port.
export interface Store {
  createKitchen(input: CreateKitchenInput): Promise<CreateKitchenOutcome>;
  findKitchen(id: string): Promise<KitchenRow | null>;
  append(input: AppendInput): Promise<AppendOutcome>;
  linesForDay(kitchenId: string, businessDay: string): Promise<StoredLine[]>;
}

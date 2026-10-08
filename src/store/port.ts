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

type KitchenKind = 'demo' | 'scratch';
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

// The line a correction's confirmed number supersedes, with what its new line is judged against.
// superseded says a line already supersedes it: a chain whose question a hold, a refusal or "Log it
// by hand" answered has corrected nothing yet.
export interface SupersedeTarget {
  lineId: string;
  rootId: string;
  ruleSnapshot: string | null;
  rulesVersion: string | null;
  superseded: boolean;
}

// An event that asked a question, as the call answering it needs it. repeats counts the misses so
// far on a digit-repeat chain: every digit_repeat hold after the chain's first, and every refusal of
// a numberless answer on it, this prompt included (0 for the first hold and for any prompt off a chain).
// supersedes is set when the chain this prompt belongs to started from a "wrong number".
export interface PendingPrompt {
  id: string;
  promptKind: string;
  checkPointId: string | null;
  measured: string | null;
  valueTenths: number | null;
  initials: string | null;
  screenId: string;
  expiresAt: number;
  refId: string | null;
  answered: boolean;
  repeats: number;
  supersedes: SupersedeTarget | null;
}

// The newest event a screen wrote that is not a receipt, as "wrong number" needs it. corrections
// counts the lines of the chain a reading heads that a wrong_number event already said wrong.
export interface ScreenEvent {
  id: string;
  kind: Exclude<EventKind, 'receipt'>;
  occurredAt: number;
  checkPointId: string | null;
  measured: string | null;
  valueTenths: number | null;
  promptKind: string | null;
  expiresAt: number | null;
  answered: boolean;
  corrections: number;
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

// What a stored event keeps of the call that wrote it, for deciding a repeat of its request id.
export interface StoredRequest {
  argsHash: string;
  occurredAt: number;
  resultJson: string;
}

export type RepeatOutcome = Extract<AppendOutcome, { status: 'duplicate' | 'expired' | 'reused' }>;

// The one rule for a request id already stored, applied by the adapter's read before deciding and by
// every store's own lookup on append, so no call is a duplicate on one path and expired on the other.
// The age runs from the stored event and is never refreshed by a repeat: a host that restarts its id
// counter in a new conversation must have its new reading refused loudly, not answered with an old one.
export function classifyRepeat(stored: StoredRequest, argsHash: string, now: number, retryWindowMs: number): RepeatOutcome {
  if (stored.argsHash !== argsHash) return { status: 'reused' };
  if (now - stored.occurredAt > retryWindowMs) return { status: 'expired', resultJson: stored.resultJson };
  return { status: 'duplicate', resultJson: stored.resultJson };
}

// No method edits or removes an event: the record is append-only, and expiring a whole scratch
// kitchen is retention, which lives outside this port.
export interface Store {
  createKitchen(input: CreateKitchenInput): Promise<CreateKitchenOutcome>;
  findKitchen(id: string): Promise<KitchenRow | null>;
  append(input: AppendInput): Promise<AppendOutcome>;
  linesForDay(kitchenId: string, businessDay: string): Promise<StoredLine[]>;
  openChecks(kitchenId: string, businessDay: string): Promise<string[]>;
  pendingPrompt(kitchenId: string, promptId: string): Promise<PendingPrompt | null>;
  latestByScreen(kitchenId: string, screenId: string, sinceMs: number): Promise<ScreenEvent | null>;
  findByRequest(kitchenId: string, requestId: string): Promise<StoredRequest | null>;
}

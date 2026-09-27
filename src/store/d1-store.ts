import type { AppendInput, AppendOutcome, D1Like, KitchenRow, Store, StoredLine } from './port';

// Statement 1 of the append batch. The day line and the record code are allocated inside the INSERT,
// so two concurrent appends can never read the same MAX, and the stored result is complete at insert
// time: the record is append-only, so it could never be finished by a later UPDATE. The WHERE holds
// the write window, the line cap and the daily budget in the same statement as the write.
const INSERT_EVENT = `
INSERT INTO events (
  id, kitchen_id, kind, occurred_at, business_day, time_zone, day_line, screen_id, request_id,
  origin, check_point_id, measured, initials, words, value_tenths, unit, outcome, verdict, rule_id,
  rule_snapshot, rules_version, supersedes_id, root_id, ref_id, answers_id, prompt_kind,
  expires_at, due_slot_id, due_at, result_json, args_hash
)
SELECT
  ?1, ?2, ?3, ?4, ?5, ?6, line.n, ?7, ?8,
  ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
  ?19, ?20, ?21, ?22, ?23, ?24, ?25,
  ?26, ?27, ?28,
  CASE
    WHEN line.n IS NULL THEN ?30
    ELSE json_set(
      ?30,
      '$.structuredContent.recordCode',
      substr(?5, 3, 2) || substr(?5, 6, 2) || substr(?5, 9, 2) || '-' || printf('%03d', line.n)
    )
  END,
  ?29
FROM (
  SELECT CASE
    WHEN ?3 IN ('reading', 'refusal')
      THEN (SELECT COALESCE(MAX(day_line), 0) + 1 FROM events WHERE kitchen_id = ?2 AND business_day = ?5)
  END AS n
) AS line
WHERE COALESCE((SELECT rows FROM budget WHERE utc_date = ?31), 0) + ?32 <= ?33
  AND (SELECT COUNT(*) FROM events WHERE kitchen_id = ?2) < ?34
  AND EXISTS (
    SELECT 1 FROM kitchens WHERE id = ?2 AND kind = 'scratch' AND created_at + ?35 > ?36
  )
RETURNING seq, day_line, result_json`;

// Statement 2: the budget only counts a write that happened.
const COUNT_BUDGET = `
INSERT INTO budget (utc_date, rows) SELECT ?1, ?2 WHERE changes() > 0
ON CONFLICT (utc_date) DO UPDATE SET rows = rows + excluded.rows`;

// One read serves both the unique-error path and the refused path: a stored event for the request id
// decides first, because a retry must get its stored result even after the window, the cap or the
// budget would refuse a new write.
const FOLLOW_UP = `
SELECT
  stored.result_json AS result_json,
  stored.args_hash AS args_hash,
  stored.occurred_at AS occurred_at,
  EXISTS (
    SELECT 1 FROM kitchens WHERE id = ?1 AND kind = 'scratch' AND created_at + ?3 > ?4
  ) AS kitchen_open,
  (SELECT COUNT(*) FROM events WHERE kitchen_id = ?1) AS line_count
FROM (SELECT 1) AS one
LEFT JOIN events AS stored ON stored.kitchen_id = ?1 AND stored.request_id = ?2`;

const INSERT_KITCHEN = `
INSERT INTO kitchens (id, kind, label, time_zone, day_start, created_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6)`;

const SELECT_KITCHEN = `
SELECT id, kind, label, time_zone, day_start, created_at FROM kitchens WHERE id = ?1`;

const SELECT_DAY = `
SELECT * FROM events WHERE kitchen_id = ?1 AND business_day = ?2 ORDER BY seq`;

interface InsertedRow {
  seq: number;
  day_line: number | null;
  result_json: string;
}

interface FollowUpRow {
  result_json: string | null;
  args_hash: string | null;
  occurred_at: number | null;
  kitchen_open: number;
  line_count: number;
}

interface KitchenRecord {
  id: string;
  kind: KitchenRow['kind'];
  label: KitchenRow['label'];
  time_zone: string;
  day_start: string;
  created_at: number;
}

type EventRecord = Record<string, unknown>;

function uniqueIndexIn(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = /UNIQUE constraint failed: ([\w., ]+)/.exec(message);
  return match ? match[1] : null;
}

function decideRepeat(row: FollowUpRow, input: AppendInput): AppendOutcome | null {
  if (row.result_json === null || row.occurred_at === null) return null;
  if (row.args_hash !== input.event.argsHash) return { status: 'reused' };
  // Measured from the stored event, never refreshed by a repeat: a host that restarts its id counter
  // in a new conversation must have its new reading refused loudly, not answered with an old one.
  if (input.now - row.occurred_at > input.retryWindowMs) return { status: 'expired', resultJson: row.result_json };
  return { status: 'duplicate', resultJson: row.result_json };
}

function refusalFor(row: FollowUpRow, input: AppendInput): AppendOutcome {
  if (!row.kitchen_open) return { status: 'refused', reason: 'kitchen_closed' };
  if (row.line_count >= input.kitchenLineCap) return { status: 'refused', reason: 'kitchen_full' };
  return { status: 'refused', reason: 'budget_full' };
}

function toStoredLine(row: EventRecord): StoredLine {
  return {
    seq: row.seq as number,
    dayLine: row.day_line as number | null,
    resultJson: row.result_json as string,
    id: row.id as string,
    kitchenId: row.kitchen_id as string,
    kind: row.kind as StoredLine['kind'],
    occurredAt: row.occurred_at as number,
    businessDay: row.business_day as string,
    timeZone: row.time_zone as string,
    screenId: row.screen_id as string,
    requestId: row.request_id as string,
    origin: row.origin as StoredLine['origin'],
    checkPointId: row.check_point_id as string | null,
    measured: row.measured as string | null,
    initials: row.initials as string | null,
    words: row.words as string,
    valueTenths: row.value_tenths as number | null,
    unit: row.unit as StoredLine['unit'],
    outcome: row.outcome as string,
    verdict: row.verdict as string | null,
    ruleId: row.rule_id as string | null,
    ruleSnapshot: row.rule_snapshot as string | null,
    rulesVersion: row.rules_version as string | null,
    supersedesId: row.supersedes_id as string | null,
    rootId: row.root_id as string | null,
    refId: row.ref_id as string | null,
    answersId: row.answers_id as string | null,
    promptKind: row.prompt_kind as string | null,
    expiresAt: row.expires_at as number | null,
    dueSlotId: row.due_slot_id as string | null,
    dueAt: row.due_at as number | null,
    argsHash: row.args_hash as string,
  };
}

export class D1Store implements Store {
  constructor(private readonly db: D1Like) {}

  async createKitchen(row: KitchenRow): Promise<void> {
    await this.db
      .prepare(INSERT_KITCHEN)
      .bind(row.id, row.kind, row.label, row.timeZone, row.dayStart, row.createdAt)
      .run();
  }

  async findKitchen(id: string): Promise<KitchenRow | null> {
    const row = await this.db.prepare(SELECT_KITCHEN).bind(id).first<KitchenRecord>();
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      label: row.label,
      timeZone: row.time_zone,
      dayStart: row.day_start,
      createdAt: row.created_at,
    };
  }

  async append(input: AppendInput): Promise<AppendOutcome> {
    const { event } = input;
    const insert = this.db
      .prepare(INSERT_EVENT)
      .bind(
        event.id, event.kitchenId, event.kind, event.occurredAt, event.businessDay, event.timeZone,
        event.screenId, event.requestId, event.origin, event.checkPointId, event.measured, event.initials,
        event.words, event.valueTenths, event.unit, event.outcome, event.verdict, event.ruleId,
        event.ruleSnapshot, event.rulesVersion, event.supersedesId, event.rootId, event.refId,
        event.answersId, event.promptKind, event.expiresAt, event.dueSlotId, event.dueAt,
        event.argsHash, input.resultTemplate, input.utcDate, input.expectedRows, input.dailyRowCap,
        input.kitchenLineCap, input.writeWindowMs, input.now,
      );
    const count = this.db.prepare(COUNT_BUDGET).bind(input.utcDate, input.expectedRows);

    let results;
    try {
      results = await this.db.batch<InsertedRow>([insert, count]);
    } catch (error) {
      return this.afterUniqueError(error, input);
    }
    const inserted = results[0].results[0];
    if (!inserted) return this.afterNoWrite(input);
    return { status: 'appended', seq: inserted.seq, dayLine: inserted.day_line, resultJson: inserted.result_json };
  }

  async linesForDay(kitchenId: string, businessDay: string): Promise<StoredLine[]> {
    const rows = await this.db.prepare(SELECT_DAY).bind(kitchenId, businessDay).all<EventRecord>();
    return rows.results.map(toStoredLine);
  }

  private async followUp(input: AppendInput): Promise<FollowUpRow> {
    const row = await this.db
      .prepare(FOLLOW_UP)
      .bind(input.event.kitchenId, input.event.requestId, input.writeWindowMs, input.now)
      .first<FollowUpRow>();
    if (!row) throw new Error('the append follow-up read returned no row');
    return row;
  }

  // A retried answer or correction trips answers_id or supersedes_id as well as the request id, and
  // SQLite names whichever index it checked first, so the stored request id decides before the index.
  private async afterUniqueError(error: unknown, input: AppendInput): Promise<AppendOutcome> {
    const index = uniqueIndexIn(error);
    if (index === null) throw error;
    const repeat = decideRepeat(await this.followUp(input), input);
    if (repeat) return repeat;
    if (index === 'events.supersedes_id') return { status: 'conflict', constraint: 'supersedes' };
    if (index === 'events.answers_id') return { status: 'conflict', constraint: 'answers' };
    throw error;
  }

  private async afterNoWrite(input: AppendInput): Promise<AppendOutcome> {
    const row = await this.followUp(input);
    return decideRepeat(row, input) ?? refusalFor(row, input);
  }
}

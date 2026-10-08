import {
  classifyRepeat,
  type AppendInput,
  type AppendOutcome,
  type CreateKitchenInput,
  type CreateKitchenOutcome,
  type D1Like,
  type KitchenRow,
  type PendingPrompt,
  type RepeatOutcome,
  type ScreenEvent,
  type Store,
  type StoredLine,
  type StoredRequest,
  type SupersedeTarget,
} from './port';

// Statement 1 of the append batch. The day line and the record code are allocated inside the INSERT,
// so two concurrent appends can never read the same MAX, and the stored result is complete at insert
// time: the record is append-only, so it could never be finished by a later UPDATE. The WHERE holds
// the write window, the line cap and the daily budget in the same statement as the write. MAX skips
// nulls anyway; saying day_line IS NOT NULL lets the partial index events_day_line serve the next line
// number, where otherwise every line of the day is read to find it.
// The WHERE sits inside the derived table: on the outer SELECT, SQLite also pushes it down into the
// derived table and checks it in both places. The line cap reads the kitchen's counter row by key, so
// no guard walks the kitchen's lines, on a refused call either.
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
      THEN (
        SELECT COALESCE(MAX(day_line), 0) + 1 FROM events
        WHERE kitchen_id = ?2 AND business_day = ?5 AND day_line IS NOT NULL
      )
  END AS n
  WHERE COALESCE((SELECT rows FROM budget WHERE utc_date = ?31), 0) + ?32 <= ?33
    AND COALESCE((SELECT lines FROM kitchen_lines WHERE kitchen_id = ?2), 0) < ?34
    AND EXISTS (
      SELECT 1 FROM kitchens WHERE id = ?2 AND kind = 'scratch' AND created_at + ?35 > ?36
    )
) AS line
RETURNING seq, day_line, result_json`;

// Statement 2: the budget only counts a write that happened.
const COUNT_BUDGET = `
INSERT INTO budget (utc_date, rows) SELECT ?1, ?2 WHERE changes() > 0
ON CONFLICT (utc_date) DO UPDATE SET rows = rows + excluded.rows`;

// Statement 3 of the append batch: the budget row changed only if the event landed, so the kitchen's
// line counter moves with exactly the events that were stored.
const COUNT_LINE = `
INSERT INTO kitchen_lines (kitchen_id, lines) SELECT ?1, 1 WHERE changes() > 0
ON CONFLICT (kitchen_id) DO UPDATE SET lines = lines + 1`;

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
  COALESCE((SELECT lines FROM kitchen_lines WHERE kitchen_id = ?1), 0) AS line_count
FROM (SELECT 1) AS one
LEFT JOIN events AS stored ON stored.kitchen_id = ?1 AND stored.request_id = ?2`;

const FIND_BY_REQUEST = `
SELECT args_hash, occurred_at, result_json FROM events WHERE kitchen_id = ?1 AND request_id = ?2`;

// The budget check sits in the same statement as the insert, so two concurrent mints cannot both read
// room under the cap and both write; COUNT_BUDGET then counts it only when the row landed.
const INSERT_KITCHEN = `
INSERT INTO kitchens (id, kind, label, time_zone, day_start, created_at)
SELECT ?1, ?2, ?3, ?4, ?5, ?6
WHERE COALESCE((SELECT rows FROM budget WHERE utc_date = ?7), 0) + ?8 <= ?9`;

const SELECT_KITCHEN = `
SELECT id, kind, label, time_zone, day_start, created_at FROM kitchens WHERE id = ?1`;

const SELECT_DAY = `
SELECT * FROM events WHERE kitchen_id = ?1 AND business_day = ?2 ORDER BY seq`;

// A check is open while the newest event naming it asks for a number: a refusal, a hold or a "wrong
// number". Only the kind column decides, never a stored status or the outcome, so a retake closes the
// check without touching the refusal line, which stays counted. A correction's line is newer than the
// line it supersedes, so the newest event is always the newest line of its chain. A receipt answers a
// call and never moves a check.
const OPEN_CHECKS = `
SELECT line.check_point_id AS check_point_id
FROM (
  SELECT MAX(seq) AS seq FROM events
  WHERE kitchen_id = ?1 AND business_day = ?2 AND check_point_id IS NOT NULL AND kind <> 'receipt'
  GROUP BY check_point_id
) AS newest
JOIN events AS line ON line.seq = newest.seq
WHERE line.kind IN ('refusal', 'held', 'wrong_number')
ORDER BY line.check_point_id`;

// Null for an id naming nothing this kitchen asked, a reading or a receipt among them, so a stale or
// foreign id is a fresh call rather than a fault. Any event carrying the id as answers_id answers it,
// a receipt included, which is how "Log it by hand" closes the prompt it answers. The repeat count
// takes every miss on the chain: a hold for a different number, and a refusal for none, the only
// refusal that names a ref_id. It walks this kitchen's events, since ref_id has no index of its own,
// so it runs only for a digit repeat: SQLite evaluates only the CASE branch it takes (202 rows read at
// 198 lines otherwise).
// The supersede target is the line a "wrong number" said wrong. A wrong_number event names it in
// ref_id; any other prompt reaches it by walking answers_id back through the holds and refusals that
// answered one another until a wrong_number event. The walk ends, since an event can only answer an
// event already stored, and it runs only for a prompt that answers something: a prompt that answers
// nothing did not start from a correction, and stays one indexed read.
const PENDING_PROMPT = `
SELECT
  asked.id AS id, asked.prompt_kind AS prompt_kind, asked.check_point_id AS check_point_id,
  asked.measured AS measured, asked.value_tenths AS value_tenths, asked.initials AS initials,
  asked.screen_id AS screen_id, asked.expires_at AS expires_at, asked.ref_id AS ref_id,
  EXISTS (SELECT 1 FROM events AS answer WHERE answer.answers_id = asked.id) AS answered,
  CASE WHEN asked.prompt_kind = 'digit_repeat' THEN (
    SELECT COUNT(*) FROM events AS chain
    WHERE chain.kitchen_id = asked.kitchen_id AND chain.ref_id = COALESCE(asked.ref_id, asked.id)
      AND ((chain.kind = 'held' AND chain.prompt_kind = 'digit_repeat') OR chain.kind = 'refusal')
  ) ELSE 0 END AS repeats,
  said_wrong.id AS target_id, COALESCE(said_wrong.root_id, said_wrong.id) AS target_root_id,
  said_wrong.rule_snapshot AS target_rule_snapshot, said_wrong.rules_version AS target_rules_version,
  CASE WHEN said_wrong.id IS NULL THEN 0 ELSE EXISTS (
    SELECT 1 FROM events AS fix WHERE fix.supersedes_id = said_wrong.id
  ) END AS target_superseded
FROM events AS asked
LEFT JOIN events AS said_wrong ON said_wrong.kitchen_id = asked.kitchen_id AND said_wrong.id = (
  CASE
    WHEN asked.kind = 'wrong_number' THEN asked.ref_id
    WHEN asked.answers_id IS NOT NULL THEN (
      WITH RECURSIVE back (kind, answers_id, ref_id) AS (
        SELECT kind, answers_id, ref_id FROM events
        WHERE kitchen_id = asked.kitchen_id AND id = asked.answers_id
        UNION ALL
        SELECT prev.kind, prev.answers_id, prev.ref_id
        FROM back JOIN events AS prev ON prev.id = back.answers_id AND prev.kitchen_id = asked.kitchen_id
        WHERE back.kind <> 'wrong_number'
      )
      SELECT ref_id FROM back WHERE kind = 'wrong_number'
    )
  END
)
WHERE asked.kitchen_id = ?1 AND asked.id = ?2
  AND asked.prompt_kind IS NOT NULL AND asked.expires_at IS NOT NULL`;

// A reading's corrections are the lines of its chain a wrong_number event said wrong, the chain being
// every line whose root is the reading's root. Lines, not events: two "wrong number" calls racing on
// one line store two questions about it, and it was still said wrong once. Counted only for a reading,
// the one kind a correction can target.
const LATEST_BY_SCREEN = `
SELECT
  newest.id AS id, newest.kind AS kind, newest.occurred_at AS occurred_at,
  newest.check_point_id AS check_point_id, newest.measured AS measured,
  newest.value_tenths AS value_tenths, newest.prompt_kind AS prompt_kind, newest.expires_at AS expires_at,
  EXISTS (SELECT 1 FROM events AS answer WHERE answer.answers_id = newest.id) AS answered,
  CASE WHEN newest.kind = 'reading' THEN (
    SELECT COUNT(DISTINCT fix.ref_id) FROM events AS fix
    WHERE fix.kitchen_id = newest.kitchen_id AND fix.kind = 'wrong_number' AND fix.ref_id IN (
      SELECT link.id FROM events AS link
      WHERE link.kitchen_id = newest.kitchen_id
        AND COALESCE(link.root_id, link.id) = COALESCE(newest.root_id, newest.id)
    )
  ) ELSE 0 END AS corrections
FROM events AS newest
WHERE newest.kitchen_id = ?1 AND newest.screen_id = ?2 AND newest.occurred_at >= ?3
  AND newest.kind <> 'receipt'
ORDER BY newest.seq DESC
LIMIT 1`;

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

interface PromptRecord {
  id: string;
  prompt_kind: string;
  check_point_id: string | null;
  measured: string | null;
  value_tenths: number | null;
  initials: string | null;
  screen_id: string;
  expires_at: number;
  ref_id: string | null;
  answered: number;
  repeats: number;
  target_id: string | null;
  target_root_id: string | null;
  target_rule_snapshot: string | null;
  target_rules_version: string | null;
  target_superseded: number;
}

interface ScreenEventRecord {
  id: string;
  kind: ScreenEvent['kind'];
  occurred_at: number;
  check_point_id: string | null;
  measured: string | null;
  value_tenths: number | null;
  prompt_kind: string | null;
  expires_at: number | null;
  answered: number;
  corrections: number;
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

function decideRepeat(row: FollowUpRow, input: AppendInput): RepeatOutcome | null {
  if (row.result_json === null || row.occurred_at === null || row.args_hash === null) return null;
  const stored = { argsHash: row.args_hash, occurredAt: row.occurred_at, resultJson: row.result_json };
  return classifyRepeat(stored, input.event.argsHash, input.now, input.retryWindowMs);
}

function supersedeTargetOf(row: PromptRecord): SupersedeTarget | null {
  if (row.target_id === null) return null;
  return {
    lineId: row.target_id,
    rootId: row.target_root_id ?? row.target_id,
    ruleSnapshot: row.target_rule_snapshot,
    rulesVersion: row.target_rules_version,
    superseded: row.target_superseded !== 0,
  };
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

  async createKitchen(input: CreateKitchenInput): Promise<CreateKitchenOutcome> {
    const { kitchen } = input;
    const insert = this.db
      .prepare(INSERT_KITCHEN)
      .bind(
        kitchen.id, kitchen.kind, kitchen.label, kitchen.timeZone, kitchen.dayStart, kitchen.createdAt,
        input.utcDate, input.expectedRows, input.dailyRowCap,
      );
    const count = this.db.prepare(COUNT_BUDGET).bind(input.utcDate, input.expectedRows);
    const [inserted] = await this.db.batch([insert, count]);
    return inserted.meta.changes > 0 ? { status: 'created' } : { status: 'refused', reason: 'budget_full' };
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
    const countLine = this.db.prepare(COUNT_LINE).bind(event.kitchenId);

    let results;
    try {
      results = await this.db.batch<InsertedRow>([insert, count, countLine]);
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

  async openChecks(kitchenId: string, businessDay: string): Promise<string[]> {
    const rows = await this.db.prepare(OPEN_CHECKS).bind(kitchenId, businessDay).all<{ check_point_id: string }>();
    return rows.results.map((row) => row.check_point_id);
  }

  async pendingPrompt(kitchenId: string, promptId: string): Promise<PendingPrompt | null> {
    const row = await this.db.prepare(PENDING_PROMPT).bind(kitchenId, promptId).first<PromptRecord>();
    if (!row) return null;
    return {
      id: row.id,
      promptKind: row.prompt_kind,
      checkPointId: row.check_point_id,
      measured: row.measured,
      valueTenths: row.value_tenths,
      initials: row.initials,
      screenId: row.screen_id,
      expiresAt: row.expires_at,
      refId: row.ref_id,
      answered: row.answered !== 0,
      repeats: row.repeats,
      supersedes: supersedeTargetOf(row),
    };
  }

  async findByRequest(kitchenId: string, requestId: string): Promise<StoredRequest | null> {
    const row = await this.db
      .prepare(FIND_BY_REQUEST)
      .bind(kitchenId, requestId)
      .first<{ args_hash: string; occurred_at: number; result_json: string }>();
    return row ? { argsHash: row.args_hash, occurredAt: row.occurred_at, resultJson: row.result_json } : null;
  }

  async latestByScreen(kitchenId: string, screenId: string, sinceMs: number): Promise<ScreenEvent | null> {
    const row = await this.db.prepare(LATEST_BY_SCREEN).bind(kitchenId, screenId, sinceMs).first<ScreenEventRecord>();
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      occurredAt: row.occurred_at,
      checkPointId: row.check_point_id,
      measured: row.measured,
      valueTenths: row.value_tenths,
      promptKind: row.prompt_kind,
      expiresAt: row.expires_at,
      answered: row.answered !== 0,
      corrections: row.corrections,
    };
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

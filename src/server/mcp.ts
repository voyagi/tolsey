import { McpServer, preloadSchemas, type CallToolResult } from '@modelcontextprotocol/server';
import { DUE_NOW, DueNowInputSchema, DueNowOutputSchema, type DueNowOutput } from '../contract/due-now';
import { frozenSchema } from '../contract/frozen-schema';
import {
  LOG_READING,
  LogReadingInputSchema,
  LogReadingOutputSchema,
  type LogReadingInput,
} from '../contract/log-reading';
import { TOOL_ANNOTATIONS, TOOL_DESCRIPTIONS } from '../contract/tools';
import {
  alreadyAnswered,
  decideLogReading,
  type Decided,
  type DecisionContext,
  type Rejection,
} from '../domain/log-reading';
import { businessDay } from '../domain/business-day';
import type { KitchenProfile, RuleRow } from '../domain/rule';
import { saysCorrection } from '../domain/words';
import {
  classifyRepeat,
  expectedRowsFor,
  type AppendOutcome,
  type KitchenRow,
  type RefusalReason,
  type RowsPerWrite,
  type Store,
} from '../store/port';
import { utcDate } from './budget';
import type { StoreLimits } from './data';
import { logFault } from './guards';
import { DEMO_FULL, writeWindowMs } from './kitchens';

export interface Clock {
  now(): number;
}

export interface ServerDeps {
  store: Store;
  clock: Clock;
  kitchen: KitchenRow;
  rules: ReadonlyMap<string, RuleRow>;
  rulesVersion: string;
  profile: KitchenProfile;
  limits: StoreLimits;
  rowsPerWrite: RowsPerWrite;
}

/** @public The name and version the server reports when a client initializes. */
export const SERVER_INFO = { name: 'tolsey', version: '0.1.0' };

// Module scope, so the conversion runs once per isolate rather than on every request. Startup code
// must finish within the platform's 1-second startup limit.
const LOG_READING_INPUT = frozenSchema(LogReadingInputSchema);
const LOG_READING_OUTPUT = frozenSchema(LogReadingOutputSchema);
const DUE_NOW_INPUT = frozenSchema(DueNowInputSchema);
const DUE_NOW_OUTPUT = frozenSchema(DueNowOutputSchema);
preloadSchemas();

const SECOND_MS = 1000;

const SERVER_FAULT = 'Tolsey could not log that. Try again.';
const DUE_NOW_FAULT = 'Tolsey could not read the open checks. Try again.';
const DEMO_READ_ONLY =
  'This is the demo kitchen, and its record is read only. Start your own kitchen to log readings.';
const REQUEST_ID_REUSED =
  'Tolsey could not log that: this request_id was already used for a different call. Call again with a new request_id.';

// A rejection stores nothing and asks no stored question, so it carries no prompt id to answer: the
// host is told to send the whole reading again, never the initials alone.
const REJECTION_TEXT: Record<Rejection, string> = {
  initials_not_on_roster:
    "Those initials are not on this kitchen's roster. Who is logging? Call again with the whole reading and their initials.",
};

// The store's budget_full is answered under demo_full, the code POST /api/kitchens gives for the same
// spent day, so a host meets one public code for it whichever route it called.
const REFUSALS: Record<RefusalReason, { text: string; code: string }> = {
  kitchen_closed: { text: 'This kitchen has closed. Start a new kitchen to keep logging.', code: 'kitchen_closed' },
  kitchen_full: { text: 'This kitchen is full. Start a new kitchen to keep logging.', code: 'kitchen_full' },
  budget_full: { text: DEMO_FULL, code: 'demo_full' },
};

// The text is what the host's model reads; the machine code rides in _meta for code.
function errorResult(text: string, code: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true, _meta: { error: code } };
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// request_id is left out, so the same call under a new id hashes the same and a reused id with
// other arguments does not.
async function argsHash(args: LogReadingInput): Promise<string> {
  const entries = Object.entries(args)
    .filter(([key, value]) => key !== 'request_id' && value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(Object.fromEntries(entries))));
  return hex(digest);
}

function expiredText(resultJson: string): string {
  const stored = JSON.parse(resultJson) as { structuredContent?: { recordCode?: string } };
  const code = stored.structuredContent?.recordCode;
  return `Tolsey already logged this call earlier${code ? `, record ${code}` : ''}. Use a new request_id only for a new reading.`;
}

function resultFor(outcome: AppendOutcome): CallToolResult {
  switch (outcome.status) {
    case 'appended':
    case 'duplicate':
      return JSON.parse(outcome.resultJson) as CallToolResult;
    case 'reused':
      return errorResult(REQUEST_ID_REUSED, 'request_id_reused');
    case 'expired':
      return errorResult(expiredText(outcome.resultJson), 'request_id_expired');
    case 'refused':
      return errorResult(REFUSALS[outcome.reason].text, REFUSALS[outcome.reason].code);
    case 'conflict': {
      const error = new Error(`an event tripped the ${outcome.constraint} index outside its own path`);
      error.name = 'UnexpectedConflict';
      throw error;
    }
  }
}

function retryWindowMs(deps: ServerDeps): number {
  return deps.limits.retryWindowSeconds * SECOND_MS;
}

async function append(decision: Decided, hash: string, deps: ServerDeps, now: number): Promise<AppendOutcome> {
  const event = { ...decision.event, argsHash: hash };
  return deps.store.append({
    event,
    resultTemplate: JSON.stringify(decision.result),
    expectedRows: expectedRowsFor(event, deps.rowsPerWrite),
    utcDate: utcDate(now),
    dailyRowCap: deps.limits.dailyRowCap,
    kitchenLineCap: deps.limits.kitchenLineCap,
    writeWindowMs: writeWindowMs(deps.limits),
    retryWindowMs: retryWindowMs(deps),
    now,
  });
}

// A correction decides from the newest event this screen wrote, measured back from the one clock read
// as far as the longer of the correction window and the prompt expiry: a line is corrected inside the
// window, but a question stays correctable while it is open, and the domain holds each to its own
// limit. Any other call decides from the prompt it names.
async function decisionContext(args: LogReadingInput, deps: ServerDeps, now: number): Promise<DecisionContext> {
  const base = {
    now,
    newId: () => crypto.randomUUID(),
    kitchen: deps.kitchen,
    rules: deps.rules,
    rulesVersion: deps.rulesVersion,
    profile: deps.profile,
  };
  if (saysCorrection(args.words, deps.profile)) {
    const reachSeconds = Math.max(deps.profile.correctionWindowSeconds, deps.profile.promptExpirySeconds);
    const since = now - reachSeconds * SECOND_MS;
    return { ...base, latest: await deps.store.latestByScreen(deps.kitchen.id, args.screen_id, since) };
  }
  const promptId = args.pending_prompt_id;
  return { ...base, prompt: promptId ? await deps.store.pendingPrompt(deps.kitchen.id, promptId) : null };
}

// Another request superseded the line or answered the prompt between this call's read and its write
// (a concurrent repeat of that request's own id never gets here: the store answers it as a duplicate
// first). Only an event that answers a prompt carries either key, and a "wrong number" refusing a
// held number is one of them while naming no pending_prompt_id. The loser hears what the same call
// sent a moment later would: it is decided again from what the store now holds, so a "wrong number"
// whose hold a racing answer logged says that line wrong. A decision that still answers a prompt
// could meet the same race again, so that loser is answered from the prompt its event answered, read
// again, whichever index SQLite named and whatever the winner stored (review WR-02). That receipt
// answers nothing. When the winner took the line rather than the question (two questions about one
// line), the loser's question stays open, which reopens nothing: the winner's line is newer, so the
// check reads closed, and the question's own next answer closes it.
async function secondAnswerFor(conflict: AppendOutcome, decision: Decided, args: LogReadingInput, deps: ServerDeps, ctx: DecisionContext): Promise<Decided | null> {
  const answered = decision.event.answersId;
  if (conflict.status !== 'conflict' || answered === null) return null;
  const again = decideLogReading(args, await decisionContext(args, deps, ctx.now));
  if (again.status === 'decided' && again.event.answersId === null) return again;
  return alreadyAnswered(args, ctx, await deps.store.pendingPrompt(deps.kitchen.id, answered));
}

async function logReading(args: LogReadingInput, deps: ServerDeps): Promise<CallToolResult> {
  // The store's guarded insert refuses a demo write too; answering here keeps the judged kitchen's
  // storage untouched by any attempt, and says what to do instead.
  if (deps.kitchen.kind === 'demo') return errorResult(DEMO_READ_ONLY, 'demo_read_only');
  const now = deps.clock.now();
  const hash = await argsHash(args);
  // A retry is answered from what its first delivery stored, before anything is decided: decided
  // again, it would meet state that delivery changed (the prompt it answered now reads answered, the
  // "wrong number" it stored is now an open question). The first delivery of every call answered with
  // isError false stored exactly one event, and a retry answered here stores none, so this covers every
  // accepted call; the store's own lookup on append stays as the backstop for concurrent copies that
  // both miss this read. A call refused with isError true stored nothing, so its repeat is a new attempt
  // (MCP-07's first outcome is a stored one).
  const stored = await deps.store.findByRequest(deps.kitchen.id, args.request_id);
  if (stored) return resultFor(classifyRepeat(stored, hash, now, retryWindowMs(deps)));

  const ctx = await decisionContext(args, deps, now);
  const decision = decideLogReading(args, ctx);
  if (decision.status === 'rejected') return errorResult(REJECTION_TEXT[decision.code], decision.code);

  const outcome = await append(decision, hash, deps, now);
  const reply = await secondAnswerFor(outcome, decision, args, deps, ctx);
  if (reply === null) return resultFor(outcome);
  // The losing call still stores exactly one event under its own request id, and a refusal of that
  // append is answered like any refused append.
  return resultFor(await append(reply, hash, deps, now));
}

function openChecksText(names: readonly string[]): string {
  return names.length === 0 ? 'No checks are open.' : `Open checks: ${names.join(', ')}.`;
}

// A read writes nothing, so the demo kitchen answers too: loading the wall against it changes no record.
// The store orders open ids by id; the answer follows the profile, the order a cook walks the kitchen.
async function dueNow(deps: ServerDeps): Promise<CallToolResult> {
  const now = deps.clock.now();
  const day = businessDay(now, deps.kitchen.timeZone, deps.kitchen.dayStart);
  const open = new Set(await deps.store.openChecks(deps.kitchen.id, day));
  const openChecks = deps.profile.checkPoints
    .filter((point) => open.has(point.id))
    .map((point) => ({ id: point.id, name: point.name }));
  const result: DueNowOutput = {
    contractVersion: 1,
    businessDay: day,
    timeZone: deps.kitchen.timeZone,
    openChecks,
  };
  return {
    content: [{ type: 'text', text: openChecksText(openChecks.map((check) => check.name)) }],
    structuredContent: result,
  };
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
  });
  server.registerTool(
    LOG_READING,
    {
      description: TOOL_DESCRIPTIONS.log_reading,
      inputSchema: LOG_READING_INPUT,
      outputSchema: LOG_READING_OUTPUT,
      annotations: TOOL_ANNOTATIONS.log_reading,
    },
    async (args) => {
      try {
        return await logReading(args, deps);
      } catch (error) {
        // The SDK would echo a thrown message straight back to the caller, and it can carry the
        // cook's words and initials, so a fault answers with a fixed sentence instead.
        logFault('[log_reading]', error);
        return errorResult(SERVER_FAULT, 'server_fault');
      }
    },
  );
  server.registerTool(
    DUE_NOW,
    {
      description: TOOL_DESCRIPTIONS.due_now,
      inputSchema: DUE_NOW_INPUT,
      outputSchema: DUE_NOW_OUTPUT,
      annotations: TOOL_ANNOTATIONS.due_now,
    },
    async () => {
      try {
        return await dueNow(deps);
      } catch (error) {
        logFault('[due_now]', error);
        return errorResult(DUE_NOW_FAULT, 'server_fault');
      }
    },
  );
  return server;
}

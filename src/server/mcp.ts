import { McpServer, preloadSchemas, type CallToolResult } from '@modelcontextprotocol/server';
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
import type { KitchenProfile, RuleRow } from '../domain/rule';
import {
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
import { writeWindowMs } from './kitchens';

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
preloadSchemas();

const SECOND_MS = 1000;

const SERVER_FAULT = 'Tolsey could not log that. Try again.';
const DEMO_READ_ONLY =
  'This is the demo kitchen, and its record is read only. Start your own kitchen to log readings.';
const REQUEST_ID_REUSED =
  'Tolsey could not log that: this request_id was already used for a different call. Call again with a new request_id.';

const REJECTION_TEXT: Record<Rejection, string> = {
  initials_not_on_roster: "Those initials are not on this kitchen's roster. Who is logging?",
};

const REFUSAL_TEXT: Record<RefusalReason, string> = {
  kitchen_closed: 'This kitchen has closed. Start a new kitchen to keep logging.',
  kitchen_full: 'This kitchen is full. Start a new kitchen to keep logging.',
  budget_full: 'The demo is full for today. Try the replay.',
};

// The text is what the host's model reads; the machine code rides in _meta for code.
function errorResult(text: string, code?: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true, ...(code ? { _meta: { error: code } } : {}) };
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
      return errorResult(REFUSAL_TEXT[outcome.reason], outcome.reason);
    case 'conflict': {
      const error = new Error(`an event tripped the ${outcome.constraint} index outside its own path`);
      error.name = 'UnexpectedConflict';
      throw error;
    }
  }
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
    retryWindowMs: deps.limits.retryWindowSeconds * SECOND_MS,
    now,
  });
}

async function decisionContext(args: LogReadingInput, deps: ServerDeps, now: number): Promise<DecisionContext> {
  const promptId = args.pending_prompt_id;
  return {
    now,
    newId: () => crypto.randomUUID(),
    kitchen: deps.kitchen,
    rules: deps.rules,
    rulesVersion: deps.rulesVersion,
    profile: deps.profile,
    prompt: promptId ? await deps.store.pendingPrompt(deps.kitchen.id, promptId) : null,
  };
}

async function logReading(args: LogReadingInput, deps: ServerDeps): Promise<CallToolResult> {
  // The store's guarded insert refuses a demo write too; answering here keeps the judged kitchen's
  // storage untouched by any attempt, and says what to do instead.
  if (deps.kitchen.kind === 'demo') return errorResult(DEMO_READ_ONLY, 'demo_read_only');
  const now = deps.clock.now();
  const ctx = await decisionContext(args, deps, now);
  const decision = decideLogReading(args, ctx);
  if (decision.status === 'rejected') return errorResult(REJECTION_TEXT[decision.code], decision.code);

  const hash = await argsHash(args);
  const outcome = await append(decision, hash, deps, now);
  if (outcome.status !== 'conflict' || outcome.constraint !== 'answers') return resultFor(outcome);
  // Another request answered the prompt between this call's read and its write (a repeat of that
  // request's own id never gets here: the store answers it as a duplicate first). This call still
  // stores exactly one event, a receipt under its own request id, and a refusal of that append is
  // answered like any refused append.
  return resultFor(await append(alreadyAnswered(args, ctx), hash, deps, now));
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
  return server;
}

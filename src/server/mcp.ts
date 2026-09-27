import { McpServer, preloadSchemas, type CallToolResult } from '@modelcontextprotocol/server';
import { frozenSchema } from '../contract/frozen-schema';
import {
  LOG_READING,
  LogReadingInputSchema,
  LogReadingOutputSchema,
  type LogReadingInput,
} from '../contract/log-reading';
import { TOOL_ANNOTATIONS, TOOL_DESCRIPTIONS } from '../contract/tools';
import { decideLogReading, type Rejection } from '../domain/log-reading';
import type { KitchenProfile, RuleRow } from '../domain/rule';
import {
  expectedRowsFor,
  type AppendOutcome,
  type KitchenRow,
  type RefusalReason,
  type RowsPerWrite,
  type Store,
} from '../store/port';
import type { StoreLimits } from './data';
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

export const SERVER_INFO = { name: 'tolsey', version: '0.1.0' };

// Module scope, once per isolate: the free plan bills request CPU, not module evaluation.
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
  initials_not_on_roster: "Tolsey could not log that: those initials are not on this kitchen's roster.",
  not_handled_yet: 'Tolsey could not log that: give a check point, a number and initials.',
};

const REFUSAL_TEXT: Record<RefusalReason, string> = {
  kitchen_closed: 'This kitchen takes no new readings. Start a new kitchen to log one.',
  kitchen_full: 'This kitchen is full. Start a new kitchen to keep logging.',
  budget_full: 'The demo is full for today. Try the replay.',
};

// The text is what the host's model reads; the machine code rides in _meta for code.
function errorResult(text: string, code?: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true, ...(code ? { _meta: { error: code } } : {}) };
}

// Never the message or the arguments: an error raised while handling a call can carry the cook's
// words and initials, and the SDK would echo a thrown message straight back to the caller.
function logFault(error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
  console.error('[log_reading]', { name, code });
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

function utcDate(instantMs: number): string {
  return new Date(instantMs).toISOString().slice(0, 10);
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
      const error = new Error('a plain reading tripped a correction or answer index');
      error.name = 'UnexpectedConflict';
      throw error;
    }
  }
}

async function logReading(args: LogReadingInput, deps: ServerDeps): Promise<CallToolResult> {
  // The store's guarded insert refuses a demo write too; answering here keeps the judged kitchen's
  // storage untouched by any attempt, and says what to do instead.
  if (deps.kitchen.kind === 'demo') return errorResult(DEMO_READ_ONLY, 'demo_read_only');
  const now = deps.clock.now();
  const decision = decideLogReading(args, {
    now,
    newId: () => crypto.randomUUID(),
    kitchen: deps.kitchen,
    rules: deps.rules,
    rulesVersion: deps.rulesVersion,
    profile: deps.profile,
  });
  if (decision.status === 'rejected') return errorResult(REJECTION_TEXT[decision.code], decision.code);

  const event = { ...decision.event, argsHash: await argsHash(args) };
  const outcome = await deps.store.append({
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
  return resultFor(outcome);
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
        logFault(error);
        return errorResult(SERVER_FAULT);
      }
    },
  );
  return server;
}

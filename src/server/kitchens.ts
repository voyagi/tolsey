import type { KitchenSettings } from '../domain/business-day';
import { utcIso } from '../domain/instant';
import type { D1Like, KitchenLabel, RowsPerWrite, Store } from '../store/port';
import { readBudgetRows, utcDate } from './budget';
import type { StoreLimits } from './data';
import { jsonError, type ParsedBody } from './guards';
import type { Clock } from './mcp';
import { expireKitchens } from './retention';

export interface KitchensDeps {
  store: Store;
  db: D1Like;
  clock: Clock;
  limits: StoreLimits;
  rowsPerWrite: RowsPerWrite;
  // The zone and day start of the profile a scratch kitchen copies, so its business days follow the
  // profile it is judged and scheduled by, never a second default.
  settings: KitchenSettings;
}

interface MintedKitchen {
  id: string;
  mcpPath: string;
  expiresAt: string;
  closesAt: string;
}

const HOUR_MS = 3_600_000;
const SECOND_MS = 1000;
const KITCHEN_ID_BYTES = 16;
// The hourly Cron Trigger reaches a kitchen within one run of it turning retentionAgeHours old.
const SWEEP_INTERVAL_MS = HOUR_MS;
// A run is handed the instant it was scheduled for, with no documented start guarantee, so deletion is
// promised for a run that starts within this allowance of it (ADR 0002, write model).
const SWEEP_LATE_START_MS = 15 * 60_000;
const LABELS: ReadonlySet<string> = new Set<KitchenLabel>(['capture', 'conformance']);
const DEMO_FULL = 'The demo is full for today. Try the replay.';

type LabelChoice = { ok: true; label: KitchenLabel | null } | { ok: false; error: 'invalid_body' | 'invalid_label' };

// Writes close one retry window before retention age, so the retry of the last accepted write can
// still find its kitchen and get its stored result before the sweep may delete it.
export function writeWindowMs(limits: StoreLimits): number {
  return limits.writeWindowHours * HOUR_MS - limits.retryWindowSeconds * SECOND_MS;
}

// The latest a kitchen and its lines are deleted while the hourly runs succeed, reported as expiresAt:
// it turns retentionAgeHours old, waits for the next hourly run, and that run may start late.
export function deletionBoundMs(limits: StoreLimits): number {
  return limits.retentionAgeHours * HOUR_MS + SWEEP_INTERVAL_MS + SWEEP_LATE_START_MS;
}

function newKitchenId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(KITCHEN_ID_BYTES));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Only the label is read from a body, and only from the closed list: any other key is refused rather
// than ignored, so nothing a caller sends can reach the kitchens row by accident.
function chooseLabel(body: ParsedBody): LabelChoice {
  if (body.kind === 'empty') return { ok: true, label: null };
  if (body.kind === 'invalid' || !isPlainObject(body.value)) return { ok: false, error: 'invalid_body' };
  const { label, ...rest } = body.value;
  if (Object.keys(rest).length > 0) return { ok: false, error: 'invalid_body' };
  if (label === undefined) return { ok: true, label: null };
  if (typeof label !== 'string' || !LABELS.has(label)) return { ok: false, error: 'invalid_label' };
  return { ok: true, label: label as KitchenLabel };
}

/**
 * @public The one place a scratch kitchen id is made, whichever route asks for one.
 *
 * The budget is read before anything else, so a flood of mints refused at the cap costs one read each
 * and never a sweep. An admitted mint runs one bounded sweep round (deletion keeps happening even if
 * the Cron Trigger never fires) and then the guarded insert, which can still refuse: the budget may
 * fill between the read and the insert, this mint's own sweep included.
 */
export async function mintKitchen(deps: KitchensDeps, label: KitchenLabel | null): Promise<MintedKitchen | 'budget_full'> {
  const createdAt = deps.clock.now();
  const date = utcDate(createdAt);
  const expectedRows = deps.rowsPerWrite.kitchen_create;
  if ((await readBudgetRows(deps.db, date)) + expectedRows > deps.limits.dailyRowCap) return 'budget_full';

  await expireKitchens(deps.db, createdAt, deps.limits, deps.rowsPerWrite, deps.limits.sweepBatchLimit);
  const id = newKitchenId();
  const outcome = await deps.store.createKitchen({
    kitchen: { id, kind: 'scratch', label, ...deps.settings, createdAt },
    expectedRows,
    utcDate: date,
    dailyRowCap: deps.limits.dailyRowCap,
  });
  if (outcome.status === 'refused') return 'budget_full';
  return {
    id,
    mcpPath: `/mcp/k/${id}`,
    expiresAt: utcIso(createdAt + deletionBoundMs(deps.limits)),
    closesAt: utcIso(createdAt + writeWindowMs(deps.limits)),
  };
}

export async function handleKitchensRoute(method: string, body: ParsedBody, deps: KitchensDeps): Promise<Response> {
  if (method !== 'POST') return jsonError(405, { error: 'method_not_allowed' }, { allow: 'POST' });
  const choice = chooseLabel(body);
  if (!choice.ok) return jsonError(400, { error: choice.error });
  const minted = await mintKitchen(deps, choice.label);
  if (minted === 'budget_full') return jsonError(503, { error: 'demo_full', message: DEMO_FULL });
  return Response.json(minted, { status: 201, headers: { 'cache-control': 'no-store' } });
}

import { kitchenSettings } from '../domain/business-day';
import { utcIso } from '../domain/instant';
import type { KitchenLabel, Store } from '../store/port';
import type { StoreLimits } from './data';
import { jsonError, type ParsedBody } from './guards';
import type { Clock } from './mcp';

export interface KitchensDeps {
  store: Store;
  clock: Clock;
  limits: StoreLimits;
}

export interface MintedKitchen {
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
const LABELS: ReadonlySet<string> = new Set<KitchenLabel>(['capture', 'conformance']);

type LabelChoice = { ok: true; label: KitchenLabel | null } | { ok: false; error: 'invalid_body' | 'invalid_label' };

// Writes close one retry window before retention age, so the retry of the last accepted write can
// still find its kitchen and get its stored result before the sweep may delete it.
export function writeWindowMs(limits: StoreLimits): number {
  return limits.writeWindowHours * HOUR_MS - limits.retryWindowSeconds * SECOND_MS;
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

export async function mintKitchen(deps: KitchensDeps, label: KitchenLabel | null): Promise<MintedKitchen> {
  const createdAt = deps.clock.now();
  const id = newKitchenId();
  await deps.store.createKitchen({ id, kind: 'scratch', label, ...kitchenSettings({}), createdAt });
  return {
    id,
    mcpPath: `/mcp/k/${id}`,
    expiresAt: utcIso(createdAt + deps.limits.retentionAgeHours * HOUR_MS + SWEEP_INTERVAL_MS),
    closesAt: utcIso(createdAt + writeWindowMs(deps.limits)),
  };
}

export async function handleKitchensRoute(method: string, body: ParsedBody, deps: KitchensDeps): Promise<Response> {
  if (method !== 'POST') return jsonError(405, { error: 'method_not_allowed' }, { allow: 'POST' });
  const choice = chooseLabel(body);
  if (!choice.ok) return jsonError(400, { error: choice.error });
  const minted = await mintKitchen(deps, choice.label);
  return Response.json(minted, { status: 201, headers: { 'cache-control': 'no-store' } });
}

import { createTestHarness } from 'wrangler';
import { createWorker, type WorkerEnv } from '../server/worker';
import { D1Store } from '../store/d1-store';
import type { D1Like, StoredLine } from '../store/port';
import { openTestD1 } from './d1';

export type TargetKind = 'in-process' | 'workerd' | 'deployed';

declare module 'vitest' {
  export interface ProvidedContext {
    target: TargetKind;
  }
}

export interface TestClock {
  now(): number;
  set(instant: number): void;
}

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface Target {
  kind: TargetKind;
  baseUrl: URL;
  fetch?: FetchLike;
  clock?: TestClock;
  createKitchen(): Promise<string>;
  readLines?: (kitchenId: string, businessDay: string) => Promise<StoredLine[]>;
  dispose(): Promise<void>;
}

// The built config, not wrangler.jsonc: vite build writes dist/tolsey/wrangler.json with the
// bundled Worker, the ASSETS directory and migrations_dir pointing back at migrations/.
const BUILT_CONFIG = './dist/tolsey/wrangler.json';
const MINUTE_MS = 60_000;

function settableClock(start: number): TestClock {
  let instant = start;
  return {
    now: () => instant,
    set: (next) => {
      instant = next;
    },
  };
}

// A kitchen made a minute before the clock's instant, so the store's write window is open.
async function insertScratchKitchen(store: D1Store, now: number): Promise<string> {
  const id = crypto.randomUUID().replaceAll('-', '');
  await store.createKitchen({
    id,
    kind: 'scratch',
    label: 'conformance',
    timeZone: 'America/Chicago',
    dayStart: '04:00',
    createdAt: now - MINUTE_MS,
  });
  return id;
}

async function inProcessTarget(): Promise<Target> {
  const d1 = await openTestD1();
  const store = new D1Store(d1.db);
  const clock = settableClock(Date.now());
  const worker = createWorker({ clock });
  const env: WorkerEnv = {
    ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
    ALLOWED_HOSTNAMES: 'localhost,127.0.0.1',
    DB: d1.db,
  };
  // A Node Request built from a URL carries no Host header, and the SDK answers 403 without one.
  const fetchInProcess: FetchLike = async (url, init) => {
    const request = new Request(url, init);
    const headers = new Headers(request.headers);
    headers.set('host', new URL(String(url)).host);
    return worker.fetch(new Request(request, { headers }), env);
  };
  return {
    kind: 'in-process',
    baseUrl: new URL('http://localhost/'),
    fetch: fetchInProcess,
    clock,
    createKitchen: () => insertScratchKitchen(store, clock.now()),
    readLines: (kitchenId, businessDay) => store.linesForDay(kitchenId, businessDay),
    dispose: d1.dispose,
  };
}

async function workerdTarget(): Promise<Target> {
  const harness = createTestHarness({ workers: [{ configPath: BUILT_CONFIG }] });
  const { url } = await harness.listen();
  const worker = harness.getWorker<{ DB: D1Like }>();
  await worker.applyD1Migrations('DB');
  const store = new D1Store((await worker.getEnv()).DB);
  return {
    kind: 'workerd',
    baseUrl: url,
    createKitchen: () => insertScratchKitchen(store, Date.now()),
    readLines: (kitchenId, businessDay) => store.linesForDay(kitchenId, businessDay),
    dispose: () => harness.close(),
  };
}

// The deployed Worker has no storage reader: a kitchen is minted through its public route, and the
// conformance file asserts only what a stranger's client can see.
function deployedTarget(baseUrl: URL): Target {
  return {
    kind: 'deployed',
    baseUrl,
    async createKitchen() {
      const response = await fetch(new URL('/api/kitchens', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'conformance' }),
      });
      if (!response.ok) throw new Error(`minting a conformance kitchen failed with status ${response.status}`);
      const body = (await response.json()) as { id: string };
      return body.id;
    },
    dispose: async () => {},
  };
}

export async function resolveTarget(kind: TargetKind, deployedBaseUrl?: URL): Promise<Target> {
  if (kind === 'in-process') return inProcessTarget();
  if (kind === 'workerd') return workerdTarget();
  if (!deployedBaseUrl) throw new Error('the deployed target needs the base URL of the deployed Worker');
  return deployedTarget(deployedBaseUrl);
}

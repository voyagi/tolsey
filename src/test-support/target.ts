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

interface TestClock {
  now(): number;
  set(instant: number): void;
}

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface Target {
  kind: TargetKind;
  baseUrl: URL;
  fetch?: FetchLike;
  clock?: TestClock;
  createKitchen(): Promise<string>;
  readLines?: (kitchenId: string, businessDay: string) => Promise<StoredLine[]>;
  dispose(): Promise<void>;
}

export interface MintedKitchen {
  id: string;
  mcpPath: string;
  expiresAt: string;
  closesAt: string;
}

export interface InProcessWorker {
  baseUrl: URL;
  fetch: FetchLike;
  clock: TestClock;
  db: D1Like;
  store: D1Store;
  dispose(): Promise<void>;
}

// The built config, not wrangler.jsonc: vite build writes dist/tolsey/wrangler.json with the
// bundled Worker, the ASSETS directory and migrations_dir pointing back at migrations/.
export const BUILT_CONFIG = './dist/tolsey/wrangler.json';
const IN_PROCESS_BASE = 'http://localhost/';
// The built config lists only the deployed host, so a local run binds the names it answers on.
export const LOCAL_HOSTNAMES = 'localhost,127.0.0.1';

// The built Worker in workerd, as it deploys except for the hostnames a local run answers on.
export function builtWorkerHarness(): ReturnType<typeof createTestHarness> {
  return createTestHarness({ workers: [{ configPath: BUILT_CONFIG, vars: { ALLOWED_HOSTNAMES: LOCAL_HOSTNAMES } }] });
}

function settableClock(start: number): TestClock {
  let instant = start;
  return {
    now: () => instant,
    set: (next) => {
      instant = next;
    },
  };
}

// Every target mints its kitchen through the public route, so the conformance file writes only to a
// kitchen the Worker itself created, exactly as a stranger's client would.
export async function mintThroughRoute(
  fetchFn: FetchLike,
  baseUrl: URL,
  body: unknown = { label: 'conformance' },
): Promise<MintedKitchen> {
  const response = await fetchFn(new URL('/api/kitchens', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.status !== 201) {
    throw new Error(`minting a kitchen failed with status ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return (await response.json()) as MintedKitchen;
}

export async function openInProcessWorker(): Promise<InProcessWorker> {
  const d1 = await openTestD1();
  const clock = settableClock(Date.now());
  const worker = createWorker({ clock });
  const env: WorkerEnv = {
    ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
    ALLOWED_HOSTNAMES: LOCAL_HOSTNAMES,
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
    baseUrl: new URL(IN_PROCESS_BASE),
    fetch: fetchInProcess,
    clock,
    db: d1.db,
    store: new D1Store(d1.db),
    dispose: d1.dispose,
  };
}

async function inProcessTarget(): Promise<Target> {
  const worker = await openInProcessWorker();
  return {
    kind: 'in-process',
    baseUrl: worker.baseUrl,
    fetch: worker.fetch,
    clock: worker.clock,
    createKitchen: async () => (await mintThroughRoute(worker.fetch, worker.baseUrl)).id,
    readLines: (kitchenId, businessDay) => worker.store.linesForDay(kitchenId, businessDay),
    dispose: worker.dispose,
  };
}

async function workerdTarget(): Promise<Target> {
  const harness = builtWorkerHarness();
  const { url } = await harness.listen();
  const worker = harness.getWorker<{ DB: D1Like }>();
  await worker.applyD1Migrations('DB');
  const store = new D1Store((await worker.getEnv()).DB);
  return {
    kind: 'workerd',
    baseUrl: url,
    createKitchen: async () => (await mintThroughRoute(fetch, url)).id,
    readLines: (kitchenId, businessDay) => store.linesForDay(kitchenId, businessDay),
    dispose: () => harness.close(),
  };
}

// The deployed Worker has no storage reader: the conformance file asserts only what a stranger's
// client can see.
function deployedTarget(baseUrl: URL): Target {
  return {
    kind: 'deployed',
    baseUrl,
    createKitchen: async () => (await mintThroughRoute(fetch, baseUrl)).id,
    dispose: async () => {},
  };
}

export async function resolveTarget(kind: TargetKind, deployedBaseUrl?: URL): Promise<Target> {
  if (kind === 'in-process') return inProcessTarget();
  if (kind === 'workerd') return workerdTarget();
  if (!deployedBaseUrl) throw new Error('the deployed target needs the base URL of the deployed Worker');
  return deployedTarget(deployedBaseUrl);
}

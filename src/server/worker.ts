import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
} from '@modelcontextprotocol/server';
import { kitchenSettings } from '../domain/business-day';
import { D1Store } from '../store/d1-store';
import type { D1Like, KitchenRow, Store } from '../store/port';
import { DEMO_PROFILE, ROWS_PER_WRITE, RULES, RULES_VERSION, STORE_LIMITS } from './data';
import {
  jsonError,
  jsonRpcError,
  logFault,
  parseAllowlist,
  parseJsonBody,
  readCappedBody,
  refuseModernEra,
  type ParsedBody,
} from './guards';
import { handleKitchensRoute } from './kitchens';
import { createServer, type Clock, type ServerDeps } from './mcp';
import { runScheduledSweep } from './retention';
import { resolveScope } from './scope';

export interface WorkerEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  ALLOWED_HOSTNAMES?: string;
  DB: D1Like;
}

export interface WorkerOptions {
  clock: Clock;
  storeFor?: (env: WorkerEnv) => Store;
}

// Typed by what the handler reads, as D1Like types the database: the test program has no
// ScheduledController.
export interface ScheduledRun {
  scheduledTime: number;
  cron?: string;
}

interface ReadBody {
  forward: Request;
  parsed: ParsedBody;
}

// The seeded kitchens row of kind demo: the adapter and the store both refuse every write aimed at it.
const DEMO_KITCHEN: KitchenRow = {
  id: 'demo',
  kind: 'demo',
  label: null,
  ...kitchenSettings({ timeZone: DEMO_PROFILE.timeZone, dayStart: DEMO_PROFILE.dayStart }),
  createdAt: 0,
};

const systemClock: Clock = { now: () => Date.now() };

type RouteFamily = 'mcp' | 'api';

// Mirrors run_worker_first in wrangler.jsonc: any other path is the static assets' to answer.
function familyOf(pathname: string): RouteFamily | null {
  if (pathname === '/mcp' || pathname.startsWith('/mcp/')) return 'mcp';
  if (pathname.startsWith('/api/')) return 'api';
  return null;
}

// The handler does no Host or Origin checks of its own, so a page on another site could
// otherwise drive this endpoint from a cook's browser (DNS rebinding).
function hostOrOriginRejection(request: Request, hostnames: string[]): Response | undefined {
  return hostHeaderValidationResponse(request, hostnames) ?? originValidationResponse(request, hostnames);
}

// The body is read once, under the cap; forward carries the same bytes, because the original
// request's body is spent and the SDK must still be able to read or clone the one it gets.
async function readBody(request: Request): Promise<ReadBody | 'too_large'> {
  if (request.method !== 'POST') return { forward: request, parsed: { kind: 'empty' } };
  const bytes = await readCappedBody(request);
  if (bytes === 'too_large') return 'too_large';
  const forward = new Request(request.url, { method: request.method, headers: request.headers, body: bytes });
  return { forward, parsed: parseJsonBody(bytes) };
}

async function serveApi(request: Request, pathname: string, store: Store, db: D1Like, clock: Clock): Promise<Response> {
  const body = await readBody(request);
  if (body === 'too_large') return jsonError(413, { error: 'body_too_large' });
  if (pathname !== '/api/kitchens') return jsonError(404, { error: 'not_found' });
  return handleKitchensRoute(request.method, body.parsed, {
    store,
    db,
    clock,
    limits: STORE_LIMITS,
    rowsPerWrite: ROWS_PER_WRITE,
  });
}

async function serveMcp(request: Request, pathname: string, store: Store, clock: Clock): Promise<Response> {
  const body = await readBody(request);
  if (body === 'too_large') return jsonRpcError(413, -32000, 'Request body over 64 KiB');
  const parsedBody = body.parsed.kind === 'json' ? body.parsed.value : undefined;
  const refused = await refuseModernEra(body.forward, parsedBody);
  if (refused) return refused;
  const scope = await resolveScope(pathname, store);
  if (scope.kind === 'not_found') return jsonRpcError(404, -32000, 'Not found');
  // Deps are closed over per request, never keyed on requestInfo: for a POST the SDK hands
  // the factory a clone of the request.
  const deps: ServerDeps = {
    store,
    clock,
    kitchen: scope.kind === 'demo' ? DEMO_KITCHEN : scope.kitchen,
    rules: RULES,
    rulesVersion: RULES_VERSION,
    profile: DEMO_PROFILE,
    limits: STORE_LIMITS,
    rowsPerWrite: ROWS_PER_WRITE,
  };
  const handler = createMcpHandler(() => createServer(deps), { onerror: (error) => logFault('[mcp]', error) });
  return handler.fetch(body.forward, parsedBody === undefined ? undefined : { parsedBody });
}

// The SDK's onerror sees only what runs inside the handler. A fault out here (the body read, the
// scope lookup, the mint) would otherwise reach the platform's uncaught-exception page, which is HTML
// and would log the error's message.
function serverFault(family: RouteFamily, error: unknown): Response {
  logFault('[worker]', error);
  return family === 'api' ? jsonError(500, { error: 'server_error' }) : jsonRpcError(500, -32603, 'Internal error');
}

export function createWorker({ clock, storeFor = (env) => new D1Store(env.DB) }: WorkerOptions) {
  return {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
      const { pathname } = new URL(request.url);
      const family = familyOf(pathname);
      if (family === null) return env.ASSETS.fetch(request);
      const allowlist = parseAllowlist(env.ALLOWED_HOSTNAMES);
      if (!allowlist.ok) return jsonError(503, { error: 'allowlist_unconfigured', message: allowlist.reason });
      const rejected = hostOrOriginRejection(request, allowlist.hostnames);
      if (rejected) return rejected;
      try {
        const store = storeFor(env);
        return family === 'api'
          ? await serveApi(request, pathname, store, env.DB, clock)
          : await serveMcp(request, pathname, store, clock);
      } catch (error) {
        return serverFault(family, error);
      }
    },

    // The Cron Trigger's own instant is the sweep's clock, so a late run deletes by the hour it was
    // scheduled for. A failure is rethrown without its message, so the run still reads as failed.
    async scheduled(controller: ScheduledRun, env: WorkerEnv): Promise<void> {
      try {
        await runScheduledSweep(env.DB, controller.scheduledTime, STORE_LIMITS, ROWS_PER_WRITE);
      } catch (error) {
        logFault('[retention]', error);
        throw new Error('the retention sweep failed');
      }
    },
  };
}

export default createWorker({ clock: systemClock });

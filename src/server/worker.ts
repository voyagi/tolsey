import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
} from '@modelcontextprotocol/server';
import { kitchenSettings } from '../domain/business-day';
import { D1Store } from '../store/d1-store';
import type { D1Like, KitchenRow, Store } from '../store/port';
import { DEMO_PROFILE, ROWS_PER_WRITE, RULES, RULES_VERSION, STORE_LIMITS } from './data';
import { jsonError, parseJsonBody } from './guards';
import { handleKitchensRoute } from './kitchens';
import { createServer, type Clock, type ServerDeps } from './mcp';
import { resolveScope } from './scope';

export interface WorkerEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  ALLOWED_HOSTNAMES: string;
  DB: D1Like;
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

function allowedHostnames(env: WorkerEnv): string[] {
  return env.ALLOWED_HOSTNAMES.split(',').map((name) => name.trim()).filter(Boolean);
}

// The handler does no Host or Origin checks of its own, so a page on another site could
// otherwise drive this endpoint from a cook's browser (DNS rebinding).
function hostOrOriginRejection(request: Request, env: WorkerEnv): Response | undefined {
  const allowed = allowedHostnames(env);
  return hostHeaderValidationResponse(request, allowed) ?? originValidationResponse(request, allowed);
}

function notFound(): Response {
  return Response.json(
    { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Not found' } },
    { status: 404 },
  );
}

async function handleApi(request: Request, pathname: string, store: Store, clock: Clock): Promise<Response> {
  if (pathname !== '/api/kitchens') return jsonError(404, { error: 'not_found' });
  const bytes = request.method === 'POST' ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array();
  return handleKitchensRoute(request.method, parseJsonBody(bytes), { store, clock, limits: STORE_LIMITS });
}

async function handleMcp(request: Request, pathname: string, store: Store, clock: Clock): Promise<Response> {
  const scope = await resolveScope(pathname, store);
  if (scope.kind === 'not_found') return notFound();
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
  return createMcpHandler(() => createServer(deps)).fetch(request);
}

export function createWorker({ clock }: { clock: Clock }) {
  return {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
      const { pathname } = new URL(request.url);
      const family = familyOf(pathname);
      if (family === null) return env.ASSETS.fetch(request);
      const rejected = hostOrOriginRejection(request, env);
      if (rejected) return rejected;
      const store = new D1Store(env.DB);
      if (family === 'api') return handleApi(request, pathname, store, clock);
      return handleMcp(request, pathname, store, clock);
    },
  };
}

export default createWorker({ clock: systemClock });

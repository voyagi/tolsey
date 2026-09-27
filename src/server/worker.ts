import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
} from '@modelcontextprotocol/server';
import { kitchenSettings } from '../domain/business-day';
import { D1Store } from '../store/d1-store';
import type { D1Like, KitchenRow, Store } from '../store/port';
import { DEMO_PROFILE, ROWS_PER_WRITE, RULES, RULES_VERSION, STORE_LIMITS } from './data';
import { createServer, type Clock, type ServerDeps } from './mcp';

export interface WorkerEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  ALLOWED_HOSTNAMES: string;
  DB: D1Like;
}

// The seeded kitchens row of kind demo: the store refuses every write aimed at it.
const DEMO_KITCHEN: KitchenRow = {
  id: 'demo',
  kind: 'demo',
  label: null,
  ...kitchenSettings({ timeZone: DEMO_PROFILE.timeZone, dayStart: DEMO_PROFILE.dayStart }),
  createdAt: 0,
};

const KITCHEN_PATH = /^\/mcp\/k\/([0-9a-f]{32})$/;

const systemClock: Clock = { now: () => Date.now() };

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

async function kitchenForPath(pathname: string, store: Store): Promise<KitchenRow | null> {
  if (pathname === '/mcp' || pathname === '/mcp/') return DEMO_KITCHEN;
  const match = KITCHEN_PATH.exec(pathname);
  return match ? store.findKitchen(match[1]) : null;
}

export function createWorker({ clock }: { clock: Clock }) {
  return {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (pathname !== '/mcp' && !pathname.startsWith('/mcp/')) return env.ASSETS.fetch(request);
      const rejected = hostOrOriginRejection(request, env);
      if (rejected) return rejected;
      const store = new D1Store(env.DB);
      const kitchen = await kitchenForPath(pathname, store);
      if (!kitchen) return notFound();
      // Deps are closed over per request, never keyed on requestInfo: for a POST the SDK hands
      // the factory a clone of the request.
      const deps: ServerDeps = {
        store,
        clock,
        kitchen,
        rules: RULES,
        rulesVersion: RULES_VERSION,
        profile: DEMO_PROFILE,
        limits: STORE_LIMITS,
        rowsPerWrite: ROWS_PER_WRITE,
      };
      return createMcpHandler(() => createServer(deps)).fetch(request);
    },
  };
}

export default createWorker({ clock: systemClock });

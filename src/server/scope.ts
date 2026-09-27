import type { KitchenRow, Store } from '../store/port';

export type Scope = { kind: 'demo' } | { kind: 'scratch'; kitchen: KitchenRow } | { kind: 'not_found' };

const KITCHEN_PATH = /^\/mcp\/k\/([0-9a-f]{32})$/;

// The path is the only input that chooses where a write lands; no tool argument ever reaches here.
// A kitchen's age is not judged here: the store's guarded insert owns the write window, so a closed
// kitchen still answers with its spoken reason and a retry inside its window still gets its result.
export async function resolveScope(pathname: string, store: Store): Promise<Scope> {
  if (pathname === '/mcp' || pathname === '/mcp/') return { kind: 'demo' };
  const match = KITCHEN_PATH.exec(pathname);
  if (!match) return { kind: 'not_found' };
  const kitchen = await store.findKitchen(match[1]);
  return kitchen?.kind === 'scratch' ? { kind: 'scratch', kitchen } : { kind: 'not_found' };
}

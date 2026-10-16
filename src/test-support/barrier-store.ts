import type { PendingPrompt, Store } from '../store/port';

// The first `readers` pendingPrompt reads each wait until all of them have read, then all go on, so
// every racing call decides from the same unanswered prompt and only the unique indexes settle the
// race. A later read, such as a loser reading the prompt again after its conflict, passes straight
// through: holding it too would wait for a partner that never comes.
// Every other method runs on the inner store itself, never on a copy that inherits from it: a store
// that keeps a counter, as MemoryStore keeps its last seq, would otherwise write the counter onto the
// wrapper, and the next append made on the inner store would reuse its seq.
export function barrierStore(inner: Store, readers: number): Store {
  const waiting: (() => void)[] = [];
  const pendingPrompt = async (kitchenId: string, promptId: string): Promise<PendingPrompt | null> => {
    const read = await inner.pendingPrompt(kitchenId, promptId);
    if (waiting.length >= readers) return read;
    await new Promise<void>((release) => {
      waiting.push(release);
      if (waiting.length === readers) waiting.forEach((go) => go());
    });
    return read;
  };
  return new Proxy(inner, {
    get(target, property) {
      if (property === 'pendingPrompt') return pendingPrompt;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

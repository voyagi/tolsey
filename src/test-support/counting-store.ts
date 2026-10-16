import type { Store } from '../store/port';

export interface CountingStore {
  store: Store;
  calls: string[];
}

// Every call made through the wrapper is recorded by name, so a test can prove that a path never
// reached storage at all, which a byte-for-byte dump of the tables cannot tell apart from a write the
// store's own guard refused. That is the tool layer's boundary and nothing past it: each method runs
// with the unwrapped store as this, so a call one store method makes on its own object is not seen.
export function countingStore(inner: Store): CountingStore {
  const calls: string[] = [];
  const store = new Proxy(inner, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        calls.push(String(property));
        return (value as (...params: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store, calls };
}

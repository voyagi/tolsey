import type { Store } from '../store/port';

export interface CountingStore {
  store: Store;
  calls: string[];
}

// Every method called on the wrapped store is recorded by name, so a test can prove that a path
// never reached storage at all, which a byte-for-byte dump of the tables cannot tell apart from a
// write the store's own guard refused.
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

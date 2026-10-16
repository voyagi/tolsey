import type { Store } from '../store/port';

export interface GatedStore {
  store: Store;
  // Resolves once the first call of the gated method has read its result and is waiting.
  reached: Promise<void>;
  release: () => void;
}

// The first call of the named method gets its result from the inner store, then waits for release
// before handing it back. A test sends copy A, awaits reached, runs its twin to completion and then
// releases A, which holds A between that read and its next step: an order Promise.all gives only by
// chance. Every other call, later calls of the same method included, passes straight through.
export function gatedStore(inner: Store, method: keyof Store): GatedStore {
  let arrive = (): void => {};
  let open = (): void => {};
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let waiting = true;
  const store = new Proxy(inner, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property !== method) return value.bind(target);
      return async (...args: unknown[]) => {
        const result: unknown = await value.apply(target, args);
        if (waiting) {
          waiting = false;
          arrive();
          await gate;
        }
        return result;
      };
    },
  });
  return { store, reached, release: open };
}

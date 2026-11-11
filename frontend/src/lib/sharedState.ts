/**
 * Tiny keyed state store that lives at module level, so state survives a component
 * unmounting (e.g. switching tabs). It resets on a full page reload.
 *
 * Usage mirrors useState: `const [value, setValue] = useSharedState("key", initial)`.
 * Functional updates (`setValue(prev => ...)`) work, and updates made while the
 * component is unmounted (e.g. a stream that's still running) are kept.
 */
import { useCallback, useSyncExternalStore } from "react";

const values = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();

function subscribeTo(key: string, cb: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
  };
}

export function useSharedState<T>(
  key: string,
  initial: T,
): [T, (next: T | ((prev: T) => T)) => void] {
  const value = useSyncExternalStore(
    (cb) => subscribeTo(key, cb),
    () => (values.has(key) ? (values.get(key) as T) : initial),
    () => initial,
  );

  const setValue = useCallback(
    (next: T | ((prev: T) => T)) => {
      const prev = values.has(key) ? (values.get(key) as T) : initial;
      const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      if (Object.is(resolved, prev)) return;
      values.set(key, resolved);
      listeners.get(key)?.forEach((cb) => cb());
    },
    // `initial` is only the fallback before the first write
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  return [value, setValue];
}

// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// A small keyed cache with stale-while-revalidate, enough for this app: shared between the ledger card and
// the ledger page, invalidated after writes, optionally polled. (No TanStack Query: kept dependency-free.)
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

type Listener = { notify: () => void; run: () => void };
type Slot = {
  data?: unknown;
  error?: unknown;
  loading: boolean;
  stale: boolean;
  listeners: Set<Listener>;
};

const slots = new Map<string, Slot>();
const keyOf = (key: readonly unknown[]) => JSON.stringify(key);
const slotOf = (k: string): Slot => {
  let s = slots.get(k);
  if (!s) slots.set(k, (s = { loading: false, stale: true, listeners: new Set() }));
  return s;
};
const notify = (s: Slot) => s.listeners.forEach((l) => l.notify());

const load = (s: Slot, fn: () => Promise<unknown>) => {
  if (s.loading) return;
  s.loading = true;
  notify(s);
  fn()
    .then(
      (data) => {
        s.data = data;
        s.error = undefined;
      },
      (error: unknown) => {
        s.error = error;
      },
    )
    .finally(() => {
      s.loading = false;
      s.stale = false;
      notify(s);
    });
};

/** Marks every query whose key starts with `prefix` stale and refetches the ones on screen. */
export const invalidate = (prefix: readonly unknown[]) => {
  const head = keyOf(prefix).slice(0, -1);
  for (const [k, s] of slots) {
    if (k !== keyOf(prefix) && !k.startsWith(`${head},`)) continue;
    s.stale = true;
    [...s.listeners][0]?.run();
  }
};

export const setQueryData = (key: readonly unknown[], data: unknown) => {
  const s = slotOf(keyOf(key));
  s.data = data;
  s.error = undefined;
  s.stale = false;
  notify(s);
};

export const clearQueries = () => slots.clear();

export type QueryResult<T> = {
  data: T | undefined;
  error: unknown;
  /** First load, nothing to show yet. */
  loading: boolean;
  refetch: () => void;
};

export function useQuery<T>(
  key: readonly unknown[],
  fn: () => Promise<T>,
  opts: { enabled?: boolean; pollMs?: number } = {},
): QueryResult<T> {
  const k = keyOf(key);
  const enabled = opts.enabled ?? true;
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const slot = slotOf(k);

  const run = useCallback(() => load(slotOf(k), () => fnRef.current()), [k]);
  useEffect(() => {
    const s = slotOf(k);
    const listener: Listener = { notify: rerender, run };
    s.listeners.add(listener);
    // Stale-while-revalidate: cached data shows at once, and every mount checks the server again.
    if (enabled) run();
    const timer = enabled && opts.pollMs ? setInterval(run, opts.pollMs) : undefined;
    return () => {
      s.listeners.delete(listener);
      clearInterval(timer);
    };
  }, [k, enabled, opts.pollMs, run]);

  return {
    data: slot.data as T | undefined,
    error: slot.error,
    loading: enabled && slot.data === undefined && slot.error === undefined,
    refetch: () => {
      slotOf(k).stale = true;
      run();
    },
  };
}

/** Runs an async action with pending/error state. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true);
    setError(undefined);
    try {
      return await fnRef.current(...args);
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);
  return { run, pending, error, reset: () => setError(undefined) };
}

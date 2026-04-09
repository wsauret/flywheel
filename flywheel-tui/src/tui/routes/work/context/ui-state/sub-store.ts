/**
 * Sub-Store Factory
 *
 * Generic sub-store with 16ms throttled notifications.
 * Used to compose independent execution and output stores
 * behind the UIActions facade.
 */

import type { Listener } from "./types.js";

const THROTTLE_MS = 16;

export interface SubStore<S> {
  getState(): S;
  setState(s: S): void;
  subscribe(fn: Listener): () => void;
  notify(): void;
  notifyImmediate(): void;
}

export function createSubStore<S>(initial: S): SubStore<S> {
  let state = initial;
  const listeners = new Set<Listener>();
  let pending: ReturnType<typeof setTimeout> | null = null;

  const notify = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      listeners.forEach((l) => l());
    }, THROTTLE_MS);
  };

  const notifyImmediate = () => {
    if (pending) {
      clearTimeout(pending);
      pending = null;
    }
    listeners.forEach((l) => l());
  };

  const getState = () => state;
  const setState = (s: S) => {
    state = s;
  };
  const subscribe = (fn: Listener) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };

  return { getState, setState, subscribe, notify, notifyImmediate };
}

/**
 * Work Store
 *
 * Singleton store with 16ms throttled notifications.
 * Uses immutable state updates — each action replaces the full WorkState object.
 *
 * Production: `createStore()` returns singleton (prevents dual-instance bugs).
 * Tests: `createTestStore()` always returns fresh instance for isolation.
 */

import type { WorkState } from "../../state/types";
import type { UIActions, Listener } from "./types";
import { createPhaseActions } from "./actions/phase-actions";
import { createWorkflowActions } from "./actions/workflow-actions";
import { createNavigationActions } from "./actions/navigation-actions";

const THROTTLE_MS = 16;

function createInitialState(planName: string): WorkState {
  return {
    planName,
    version: "0.0.1",
    startTime: Date.now(),
    workflowStatus: "idle",
    phases: [],
    outputLines: [],
    outputBlocks: [],
    approvalState: { pending: false },
    selectedPhaseIndex: 0,
    scrollOffset: 0,
    visibleItemCount: 10,
  };
}

function createStoreInternal(planName: string) {
  let state = createInitialState(planName);
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
  const setState = (s: WorkState) => {
    state = s;
  };
  const subscribe = (fn: Listener) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };

  const reset = (newPlanName: string) => {
    state = createInitialState(newPlanName);
    notifyImmediate();
  };

  const ctx = { getState, setState, notify, notifyImmediate };
  const phaseActions = createPhaseActions(ctx);
  const workflowActions = createWorkflowActions(ctx);
  const navigationActions = createNavigationActions(ctx);

  return {
    getState,
    subscribe,
    reset,
    ...phaseActions,
    ...workflowActions,
    ...navigationActions,
  } satisfies UIActions;
}

// ── Singleton ──

let singletonStore: ReturnType<typeof createStoreInternal> | null = null;

/** Production: returns singleton store instance */
export function createStore(planName: string): UIActions {
  if (!singletonStore) {
    singletonStore = createStoreInternal(planName);
  }
  return singletonStore;
}

/** Alias for production usage */
export const createWorkStore = createStore;

/** Test-only: always returns a fresh, isolated store */
export function createTestStore(planName: string): UIActions {
  return createStoreInternal(planName);
}

/** Reset singleton (for cleanup between test suites) */
export function resetStore(): void {
  singletonStore = null;
}

/** Alias for backward compatibility */
export const resetWorkStore = resetStore;

/**
 * Work Store
 *
 * Singleton store with 16ms throttled notifications.
 * Uses immutable state updates — each action replaces the full WorkState object.
 *
 * Production: `createStore()` returns singleton (prevents dual-instance bugs).
 * `createTestStore()` returns a fresh instance — used in tests for isolation
 * and in production by session-viewport.ts for ephemeral read-only views.
 */

import type { WorkState } from "../../state/types";
import type { UIActions, Listener } from "./types";
import { createPhaseActions } from "./actions/phase-actions";
import { createWorkflowActions } from "./actions/workflow-actions";
import { createNavigationActions } from "./actions/navigation-actions";
import { createStageActions } from "./actions/stage-actions";

const THROTTLE_MS = 16;

function createInitialState(planName: string): WorkState {
  return {
    planName,
    version: "0.0.1",
    startTime: Date.now(),
    workflowStatus: "idle",
    phases: [],
    stages: [],
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
  const stageActions = createStageActions(ctx);
  const workflowActions = createWorkflowActions(ctx);
  const navigationActions = createNavigationActions(ctx);

  return {
    getState,
    subscribe,
    reset,
    ...phaseActions,
    ...stageActions,
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

/**
 * Returns a fresh, isolated store instance (not the singleton).
 * Used in tests for isolation AND in production by session-viewport.ts
 * for ephemeral read-only session views that need their own store.
 */
export function createTestStore(planName: string): UIActions {
  return createStoreInternal(planName);
}

/** Reset singleton (for cleanup between test suites) */
export function resetStore(): void {
  singletonStore = null;
}

/** Alias for backward compatibility */
export const resetWorkStore = resetStore;

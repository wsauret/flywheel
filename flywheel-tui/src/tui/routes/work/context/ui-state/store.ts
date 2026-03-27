/**
 * Work Store
 *
 * Factory-based store with 16ms throttled notifications.
 * Uses immutable state updates — each action replaces the full WorkState object.
 *
 * `createStore()` always returns a fresh, isolated instance.
 * No singleton — each workflow session gets its own store.
 */

import type { WorkState } from "../../state/types";
import type { UIActions, Listener } from "./types";
import { createWorkflowActions } from "./actions/workflow-actions";
import { createNavigationActions } from "./actions/navigation-actions";
import { createQueueStepActions } from "./actions/queue-step-actions";

const THROTTLE_MS = 16;

function createInitialState(planName: string): WorkState {
  return {
    planName,
    version: "0.0.1",
    startTime: Date.now(),
    workflowStatus: "idle",
    queueSteps: [],
    outputLines: [],
    outputBlocks: [],
    approvalState: { pending: false },
    selectedStepIndex: 0,
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
  const queueStepActions = createQueueStepActions(ctx);
  const workflowActions = createWorkflowActions(ctx);
  const navigationActions = createNavigationActions(ctx);

  return {
    getState,
    subscribe,
    reset,
    ...queueStepActions,
    ...workflowActions,
    ...navigationActions,
  } satisfies UIActions;
}

// ── Factory ──

/**
 * Create a fresh, isolated store instance.
 * Each call returns an independent store — no singleton caching.
 */
export function createStore(planName: string): UIActions {
  return createStoreInternal(planName);
}

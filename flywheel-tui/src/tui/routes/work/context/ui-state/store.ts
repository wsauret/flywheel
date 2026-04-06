/**
 * Work Store
 *
 * Factory-based store composed from two independent sub-stores:
 * - ExecutionState: workflow lifecycle, queue steps, navigation, approval
 * - OutputState: output lines and structured output blocks
 *
 * The UIActions facade merges both sub-stores for backward compatibility.
 * Targeted subscriptions (subscribeExecution / subscribeOutput) enable
 * subscriber isolation — output mutations never fire execution listeners
 * and vice versa.
 *
 * `createStore()` always returns a fresh, isolated instance.
 * No singleton — each workflow session gets its own store.
 */

import type { WorkState, ExecutionState, OutputState } from "@tui/types";
import type { UIActions, Listener } from "./types.js";
import { createSubStore } from "./sub-store.js";
import { createWorkflowActions } from "./actions/workflow-actions.js";
import { createNavigationActions } from "./actions/navigation-actions.js";
import { createQueueStepActions } from "./actions/queue-step-actions.js";

function createInitialExecutionState(planName: string): ExecutionState {
  return {
    planName,
    version: "0.0.1",
    startTime: Date.now(),
    workflowStatus: "idle",
    queueSteps: [],
    approvalState: { pending: false },
    selectedStepIndex: 0,
    scrollOffset: 0,
    visibleItemCount: 10,
    modelActivity: "idle",
  };
}

function createInitialOutputState(): OutputState {
  return {
    outputLines: [],
    outputBlocks: [],
  };
}

function createStoreInternal(planName: string) {
  const exec = createSubStore<ExecutionState>(
    createInitialExecutionState(planName),
  );
  const output = createSubStore<OutputState>(createInitialOutputState());

  // Facade: getState merges both sub-stores
  const getState = (): WorkState => ({
    ...exec.getState(),
    ...output.getState(),
  });

  // Facade: subscribe to both (backward compat — fires on any change)
  const subscribe = (fn: Listener): (() => void) => {
    const unsub1 = exec.subscribe(fn);
    const unsub2 = output.subscribe(fn);
    return () => {
      unsub1();
      unsub2();
    };
  };

  // Targeted subscriptions
  const subscribeExecution = (fn: Listener) => exec.subscribe(fn);
  const subscribeOutput = (fn: Listener) => output.subscribe(fn);

  // Action creators receive the appropriate sub-store context
  const execCtx = {
    getState: exec.getState,
    setState: exec.setState,
    notify: exec.notify,
    notifyImmediate: exec.notifyImmediate,
  };
  const outputCtx = {
    getState: output.getState,
    setState: output.setState,
    notify: output.notify,
    notifyImmediate: output.notifyImmediate,
  };

  const queueStepActions = createQueueStepActions(execCtx);
  const navigationActions = createNavigationActions(execCtx);
  const workflowActions = createWorkflowActions(execCtx, outputCtx);

  const reset = (newPlanName: string) => {
    exec.setState(createInitialExecutionState(newPlanName));
    output.setState(createInitialOutputState());
    exec.notifyImmediate();
    output.notifyImmediate();
  };

  return {
    getState,
    subscribe,
    subscribeExecution,
    subscribeOutput,
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

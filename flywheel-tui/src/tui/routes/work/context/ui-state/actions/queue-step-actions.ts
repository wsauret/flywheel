/**
 * Queue Step Action Creators
 *
 * Factory that takes store context and returns queue step mutation functions.
 * Used by the OpenTUI adapter to update queue step display state
 * when queue events fire (queue:initialized, queue:step-started, etc.).
 */

import type { QueueStepState, ExecutionState } from "@tui/types";
import type { StoreContext } from "./workflow-actions.js";

export function createQueueStepActions(ctx: StoreContext<ExecutionState>) {
  const { getState, setState, notify, notifyImmediate } = ctx;

  return {
    /**
     * Set the full list of queue steps (called on queue:initialized).
     * Replaces any existing queue steps.
     */
    setQueueSteps(steps: QueueStepState[]): void {
      const state = getState();
      setState({
        ...state,
        queueSteps: steps,
      });
      notifyImmediate();
    },

    /**
     * Transition a queue step to running (called on queue:step-started).
     */
    startQueueStep(stepId: string): void {
      const state = getState();
      const queueSteps = state.queueSteps.map((s) =>
        s.id === stepId
          ? { ...s, status: "running" as const, startTime: Date.now() }
          : s,
      );
      setState({ ...state, queueSteps });
      notifyImmediate();
    },

    /**
     * Transition a queue step to completed (called on queue:step-completed).
     */
    completeQueueStep(stepId: string): void {
      const state = getState();
      const queueSteps = state.queueSteps.map((s) => {
        if (s.id !== stepId) return s;
        const now = Date.now();
        const duration = s.startTime ? (now - s.startTime) / 1000 : 0;
        return { ...s, status: "completed" as const, endTime: now, duration };
      });
      setState({ ...state, queueSteps });
      notify();
    },

    /**
     * Transition a queue step to failed (called on queue:step-failed).
     */
    failQueueStep(stepId: string, reason: string): void {
      const state = getState();
      const queueSteps = state.queueSteps.map((s) => {
        if (s.id !== stepId) return s;
        const now = Date.now();
        return { ...s, status: "failed" as const, endTime: now, error: reason };
      });
      setState({ ...state, queueSteps });
      notify();
    },

    /**
     * Insert a queue step at the correct position (called on queue:step-inserted).
     * Inserts after the step with the given afterStepId.
     */
    insertQueueStep(step: QueueStepState, afterStepId: string): void {
      const state = getState();
      const idx = state.queueSteps.findIndex((s) => s.id === afterStepId);
      const insertIdx = idx >= 0 ? idx + 1 : state.queueSteps.length;
      const queueSteps = [
        ...state.queueSteps.slice(0, insertIdx),
        step,
        ...state.queueSteps.slice(insertIdx),
      ];
      setState({ ...state, queueSteps });
      notify();
    },

    /**
     * Remove a queue step by ID (called on queue:step-removed).
     */
    removeQueueStep(stepId: string): void {
      const state = getState();
      const queueSteps = state.queueSteps.filter((s) => s.id !== stepId);
      setState({ ...state, queueSteps });
      notify();
    },
  };
}

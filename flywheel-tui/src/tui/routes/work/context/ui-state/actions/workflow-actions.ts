/**
 * Workflow Action Creators
 *
 * Factory that takes store context and returns workflow mutation functions.
 */

import type { ExecutionState, OutputState, AnyBlock } from "@tui/types";

export interface StoreContext<S = any> {
  getState(): S;
  setState(s: S): void;
  notify(): void;
  notifyImmediate(): void;
}

export function createWorkflowActions(
  exec: StoreContext<ExecutionState>,
  output: StoreContext<OutputState>,
) {
  return {
    startWorkflow(planName: string): void {
      exec.setState({
        planName,
        startTime: Date.now(),
        workflowStatus: "running",
        queueSteps: [],
        approvalState: { pending: false },
        modelActivity: "idle",
      });
      output.setState({
        outputBlocks: [],
      });
      exec.notifyImmediate();
      output.notifyImmediate();
    },

    continueStep(planName: string): void {
      const state = exec.getState();
      exec.setState({
        ...state,
        planName,
        workflowStatus: "running",
        approvalState: { pending: false },
        error: undefined,
      });
      exec.notifyImmediate();
    },

    setPlanName(name: string): void {
      const state = exec.getState();
      exec.setState({ ...state, planName: name });
      exec.notify();
    },

    stopWorkflow(status: "completed" | "interrupted"): void {
      const state = exec.getState();
      exec.setState({
        ...state,
        workflowStatus: status,
        endTime: Date.now(),
      });
      exec.notify();
    },

    setError(reason: string): void {
      const state = exec.getState();
      exec.setState({
        ...state,
        workflowStatus: "failed",
        error: reason,
      });
      exec.notify();
    },

    clearError(): void {
      const state = exec.getState();
      exec.setState({
        ...state,
        error: undefined,
      });
      exec.notify();
    },

    setApprovalPending(description: string): void {
      const state = exec.getState();
      exec.setState({
        ...state,
        approvalState: { pending: true, description },
      });
      exec.notifyImmediate();
    },

    clearApproval(): void {
      const state = exec.getState();
      exec.setState({
        ...state,
        approvalState: { pending: false },
      });
      exec.notifyImmediate();
    },

    setOutputBlocks(blocks: AnyBlock[]): void {
      const state = output.getState();
      output.setState({
        ...state,
        outputBlocks: blocks,
      });
      output.notify();
    },

    appendOutputBlocks(blocks: AnyBlock[]): void {
      if (blocks.length === 0) return;
      const state = output.getState();
      output.setState({
        ...state,
        outputBlocks: [...state.outputBlocks, ...blocks],
      });
      output.notify();
    },

    setModelActivity(activity: ExecutionState["modelActivity"]): void {
      const state = exec.getState();
      exec.setState({ ...state, modelActivity: activity });
      exec.notifyImmediate();
    },
  };
}

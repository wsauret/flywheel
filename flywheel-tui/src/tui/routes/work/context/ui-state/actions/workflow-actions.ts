/**
 * Workflow Action Creators
 *
 * Factory that takes store context and returns workflow mutation functions.
 */

import type { ExecutionState, OutputState, OutputLine, AnyBlock } from "@tui/types";

export interface StoreContext<S = any> {
  getState(): S;
  setState(s: S): void;
  notify(): void;
  notifyImmediate(): void;
}

const OUTPUT_LINES_CAP = 5000;

export function createWorkflowActions(
  exec: StoreContext<ExecutionState>,
  output: StoreContext<OutputState>,
) {
  return {
    startWorkflow(planName: string): void {
      const { version, visibleItemCount } = exec.getState();
      exec.setState({
        planName,
        version,
        startTime: Date.now(),
        workflowStatus: "running",
        queueSteps: [],
        approvalState: { pending: false },
        selectedStepIndex: 0,
        scrollOffset: 0,
        visibleItemCount,
        modelActivity: "idle",
      });
      output.setState({
        outputLines: [],
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

    appendOutput(line: OutputLine): void {
      const state = output.getState();
      let lines = [...state.outputLines, line];
      if (lines.length > OUTPUT_LINES_CAP) {
        lines = lines.slice(lines.length - OUTPUT_LINES_CAP);
      }
      output.setState({
        ...state,
        outputLines: lines,
      });
      output.notify();
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

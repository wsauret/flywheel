/**
 * Workflow Action Creators
 *
 * Factory that takes store context and returns workflow mutation functions.
 */

import type { WorkState, OutputLine, AnyBlock } from "../../../state/types";

export interface StoreContext {
  getState(): WorkState;
  setState(s: WorkState): void;
  notify(): void;
  notifyImmediate(): void;
}

const OUTPUT_LINES_CAP = 5000;

export function createWorkflowActions(ctx: StoreContext) {
  const { getState, setState, notify, notifyImmediate } = ctx;

  return {
    startWorkflow(planName: string): void {
      setState({
        planName,
        version: getState().version,
        startTime: Date.now(),
        workflowStatus: "running",
        queueSteps: [],
        outputLines: [],
        outputBlocks: [],
        approvalState: { pending: false },
        selectedPhaseIndex: 0,
        scrollOffset: 0,
        visibleItemCount: getState().visibleItemCount,
      });
      notifyImmediate();
    },

    continueStage(planName: string): void {
      const state = getState();
      setState({
        ...state,
        planName,
        workflowStatus: "running",
        approvalState: { pending: false },
        error: undefined,
        // Preserve: outputBlocks, outputLines, phases, startTime, scrollOffset
      });
      notifyImmediate();
    },

    stopWorkflow(status: "completed" | "interrupted"): void {
      const state = getState();
      setState({
        ...state,
        workflowStatus: status,
        endTime: Date.now(),
      });
      notify();
    },

    setError(reason: string): void {
      const state = getState();
      setState({
        ...state,
        workflowStatus: "failed",
        error: reason,
      });
      notify();
    },

    clearError(): void {
      const state = getState();
      setState({
        ...state,
        error: undefined,
      });
      notify();
    },

    appendOutput(line: OutputLine): void {
      const state = getState();
      let lines = [...state.outputLines, line];
      if (lines.length > OUTPUT_LINES_CAP) {
        lines = lines.slice(lines.length - OUTPUT_LINES_CAP);
      }
      setState({
        ...state,
        outputLines: lines,
      });
      notify();
    },

    setApprovalPending(description: string): void {
      const state = getState();
      setState({
        ...state,
        approvalState: { pending: true, description },
      });
      notifyImmediate();
    },

    clearApproval(): void {
      const state = getState();
      setState({
        ...state,
        approvalState: { pending: false },
      });
      notifyImmediate();
    },

    setOutputBlocks(blocks: AnyBlock[]): void {
      const state = getState();
      setState({
        ...state,
        outputBlocks: blocks,
      });
      notify();
    },

    appendOutputBlocks(blocks: AnyBlock[]): void {
      if (blocks.length === 0) return;
      const state = getState();
      setState({
        ...state,
        outputBlocks: [...state.outputBlocks, ...blocks],
      });
      notify();
    },
  };
}

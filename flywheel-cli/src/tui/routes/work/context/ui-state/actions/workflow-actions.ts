/**
 * Workflow Action Creators
 *
 * Factory that takes store context and returns workflow mutation functions.
 */

import type { WorkState, OutputLine } from "../../../state/types";
import type { StoreContext } from "./phase-actions";

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
        phases: [],
        outputLines: [],
        approvalState: { pending: false },
        selectedPhaseIndex: 0,
        scrollOffset: 0,
        visibleItemCount: getState().visibleItemCount,
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
  };
}

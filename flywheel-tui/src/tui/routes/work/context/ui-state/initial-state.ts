/**
 * Initial State Factory
 *
 * NOTE: The primary initial state factory is in store.ts (createInitialState).
 * This file is kept for backward compatibility with the provider.
 */

import type { WorkState } from "../../state/types";

/**
 * Create initial workflow UI state
 */
export function createInitialState(planName: string): WorkState {
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

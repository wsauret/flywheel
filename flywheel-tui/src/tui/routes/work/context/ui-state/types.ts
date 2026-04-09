/**
 * UI State Types
 *
 * Types for the UI state store and actions.
 * Re-exports WorkState types for convenience.
 */

import type { WorkState, AnyBlock, WorkflowStatus as WfStatus, QueueStepState } from "@tui/types";

export type Listener = () => void;

/** Actions exposed by the work store */
export interface UIActions {
  getState(): WorkState;
  subscribe(fn: Listener): () => void;

  // Workflow actions
  startWorkflow(planName: string): void;
  /** Update metadata for a new queue step without wiping output. */
  continueStep(planName: string): void;
  /** Update the session display name without resetting state. */
  setPlanName(name: string): void;
  stopWorkflow(status: "completed" | "interrupted"): void;
  setError(reason: string): void;
  clearError(): void;
  setOutputBlocks(blocks: AnyBlock[]): void;
  appendOutputBlocks(blocks: AnyBlock[]): void;
  setApprovalPending(description: string): void;
  clearApproval(): void;
  setModelActivity(activity: "idle" | "thinking" | "generating" | "tool_executing"): void;

  // Queue step actions (queue-based panel display)
  setQueueSteps(steps: QueueStepState[]): void;
  startQueueStep(stepId: string): void;
  completeQueueStep(stepId: string): void;
  failQueueStep(stepId: string, reason: string): void;
  insertQueueStep(step: QueueStepState, afterStepId: string): void;
  removeQueueStep(stepId: string): void;

  // Targeted subscriptions (subscriber isolation)
  subscribeExecution(fn: Listener): () => void;
  subscribeOutput?(fn: Listener): () => void;

  // Reset
  reset(planName: string): void;

  // Toast (optional)
  showToast?(variant: "success" | "error" | "info" | "warning", message: string): void;
}

export type { WfStatus as WorkflowStatus };

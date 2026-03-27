/**
 * UI State Types
 *
 * Types for the UI state store and actions.
 * Re-exports WorkState types for convenience.
 */

import type { WorkState, OutputLine, AnyBlock, WorkflowStatus as WfStatus, QueueStepState } from "../../state/types";

export type Listener = () => void;

/** Actions exposed by the work store */
export interface UIActions {
  getState(): WorkState;
  subscribe(fn: Listener): () => void;

  // Workflow actions
  startWorkflow(planName: string): void;
  /** Update metadata for a new queue step without wiping output. */
  continueStep(planName: string): void;
  stopWorkflow(status: "completed" | "interrupted"): void;
  setError(reason: string): void;
  clearError(): void;
  appendOutput(line: OutputLine): void;
  setOutputBlocks(blocks: AnyBlock[]): void;
  appendOutputBlocks(blocks: AnyBlock[]): void;
  setApprovalPending(description: string): void;
  clearApproval(): void;

  // Queue step actions (queue-based panel display)
  setQueueSteps(steps: QueueStepState[]): void;
  startQueueStep(stepId: string): void;
  completeQueueStep(stepId: string): void;
  failQueueStep(stepId: string, reason: string): void;
  insertQueueStep(step: QueueStepState, afterStepId: string): void;
  removeQueueStep(stepId: string): void;

  // Navigation actions
  selectNext(): void;
  selectPrevious(): void;
  selectStep(index: number): void;

  // Reset
  reset(planName: string): void;

  // Toast (optional)
  showToast?(variant: "success" | "error" | "info" | "warning", message: string): void;
}

// Re-export for backward compatibility with existing index.ts
export type WorkflowState = WorkState;
export type { WfStatus as WorkflowStatus };

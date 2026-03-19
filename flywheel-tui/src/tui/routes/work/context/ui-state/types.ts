/**
 * UI State Types
 *
 * Types for the UI state store and actions.
 * Re-exports WorkState types for convenience.
 */

import type { WorkState, OutputLine, AnyBlock, WorkflowStatus as WfStatus, PhaseStatus } from "../../state/types";

export type Listener = () => void;

/** Actions exposed by the work store */
export interface UIActions {
  getState(): WorkState;
  subscribe(fn: Listener): () => void;

  // Phase actions
  addPhase(phase: { index: number; name: string }): void;
  startPhase(index: number, name: string): void;
  completePhase(index: number): void;
  failPhase(index: number, reason: string): void;
  skipPhase(index: number): void;

  // Workflow actions
  startWorkflow(planName: string): void;
  /** Update metadata for a new pipeline stage without wiping output. */
  continueStage(planName: string): void;
  stopWorkflow(status: "completed" | "interrupted"): void;
  setError(reason: string): void;
  clearError(): void;
  appendOutput(line: OutputLine): void;
  setOutputBlocks(blocks: AnyBlock[]): void;
  appendOutputBlocks(blocks: AnyBlock[]): void;
  setApprovalPending(description: string): void;
  clearApproval(): void;

  // Navigation actions
  selectNext(): void;
  selectPrevious(): void;
  selectPhase(index: number): void;

  // Reset
  reset(planName: string): void;

  // Toast (optional)
  showToast?(variant: "success" | "error" | "info" | "warning", message: string): void;
}

// Re-export for backward compatibility with existing index.ts
// The existing index.ts exports: UIActions, WorkflowState, AgentStatus, WorkflowStatus
export type WorkflowState = WorkState;
export type AgentStatus = PhaseStatus;
export type { WfStatus as WorkflowStatus };

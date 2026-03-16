/**
 * Work State Types
 *
 * Core state types for the Flywheel workflow TUI.
 * These are the "source of truth" shapes used by the store and actions.
 */

export type PhaseStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "manual-review";

export type WorkflowStatus = "idle" | "running" | "completed" | "failed" | "interrupted" | "stopping";

export interface PhaseState {
  index: number;
  name: string;
  status: PhaseStatus;
  startTime?: number;
  endTime?: number;
  duration?: number;
  error?: string;
}

export interface WorkerState {
  phaseIndex: number;
  stepIndex: number;
  status: "running" | "completed" | "failed" | "retrying";
  attempt?: number;
  maxAttempts?: number;
}

export interface ApprovalState {
  pending: boolean;
  description?: string;
}

export interface OutputLine {
  stream: "stdout" | "stderr";
  data: string;
  timestamp: string;
}

export interface WorkState {
  planName: string;
  version: string;
  startTime: number;
  endTime?: number;
  workflowStatus: WorkflowStatus;
  phases: PhaseState[];
  outputLines: OutputLine[];
  approvalState: ApprovalState;
  selectedPhaseIndex: number;
  scrollOffset: number;
  visibleItemCount: number;
  error?: string;
}

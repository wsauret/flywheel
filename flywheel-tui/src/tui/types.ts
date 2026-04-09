/**
 * Work State Types
 *
 * Core state types for the Flywheel workflow TUI.
 * These are the "source of truth" shapes used by the store and actions.
 */

export type WorkflowStatus = "idle" | "running" | "completed" | "failed" | "interrupted" | "stopping";

// ---------------------------------------------------------------------------
// Queue step display state (used by workflow panel to show queue progress)
// ---------------------------------------------------------------------------

export type QueueStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface QueueStepState {
  /** Unique step ID (from queue Step). */
  id: string;
  /** Step type (plan, work, review, etc.). */
  type: string;
  /** Human-readable step title. */
  title: string;
  /** Current status. */
  status: QueueStepStatus;
  /** Error message when status is "failed". */
  error?: string;
  /** Start time (epoch ms) for duration tracking. */
  startTime?: number;
  /** End time (epoch ms). */
  endTime?: number;
  /** Duration in seconds. */
  duration?: number;
}

export interface ApprovalState {
  pending: boolean;
  description?: string;
}

// ── Structured Output Blocks (canonical definitions in infra/output-blocks.ts) ──

import type { AnyBlock as _AnyBlock } from "../infra/output-blocks";

export type {
  TextBlock,
  ToolBlock,
  AgentBlock,
  ContextGroupBlock,
  SystemBlock,
  ThinkingBlock,
  UserMessageBlock,
  AnyBlock,
} from "../infra/output-blocks";

// ---------------------------------------------------------------------------
// Split state types — ExecutionState and OutputState are independent stores
// composed behind the UIActions facade. WorkState is their union (backward compat).
// ---------------------------------------------------------------------------

/** Workflow lifecycle, queue steps, approval, navigation, error. */
export interface ExecutionState {
  planName: string;
  startTime: number;
  endTime?: number;
  workflowStatus: WorkflowStatus;
  /** Queue step display states for the workflow panel. */
  queueSteps: QueueStepState[];
  approvalState: ApprovalState;
  error?: string;
  modelActivity: "idle" | "thinking" | "generating" | "tool_executing";
}

/** Structured output blocks. */
export interface OutputState {
  outputBlocks: _AnyBlock[];
}

/** Combined state — backward compatible union of ExecutionState + OutputState. */
export interface WorkState extends ExecutionState, OutputState {}

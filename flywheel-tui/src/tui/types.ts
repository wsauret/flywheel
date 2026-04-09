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

// ── Structured Output Blocks (canonical definitions in infra/output-blocks.ts) ──

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

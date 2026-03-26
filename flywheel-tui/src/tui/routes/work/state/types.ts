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

// ── Structured Output Blocks ──

export interface TextBlock {
  kind: "text";
  content: string;
  timestamp: number;
}

export interface ToolBlock {
  kind: "tool";
  name: string;
  detail: string;
  timestamp: number;
}

export interface AgentBlock {
  kind: "agent";
  id: string;
  agentLabel: string;
  description: string;
  status: "active" | "completed" | "error" | "paused";
  children: ToolBlock[];
  latestChild?: string;
  duration?: number;
  toolCount?: number;
  errorMessage?: string;
  timestamp: number;
}

export interface ContextGroupBlock {
  kind: "contextGroup";
  tools: ToolBlock[];
  timestamp: number;
}

export interface SystemBlock {
  kind: "system";
  message: string;
  timestamp: number;
}

export type AnyBlock = TextBlock | ToolBlock | AgentBlock | ContextGroupBlock | SystemBlock;

export interface WorkState {
  planName: string;
  version: string;
  startTime: number;
  endTime?: number;
  workflowStatus: WorkflowStatus;
  /** Queue step display states for the workflow panel. */
  queueSteps: QueueStepState[];
  /**
   * @deprecated Prefer `outputBlocks` for display. `outputLines` is retained
   * for the console adapter and raw-mode passthrough. The OpenTUI adapter now
   * routes all output (including system messages and stderr) through the
   * structured block pipeline.
   */
  outputLines: OutputLine[];
  outputBlocks: AnyBlock[];
  approvalState: ApprovalState;
  selectedPhaseIndex: number;
  scrollOffset: number;
  visibleItemCount: number;
  error?: string;
}

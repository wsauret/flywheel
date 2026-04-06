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
  /** Unified diff string for Edit/Write/ApplyPatch tools */
  diff?: string;
  /** File type for syntax highlighting in diff rendering */
  filetype?: string;
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
  /** Whether the block's children are expanded (visible). Default: false (collapsed). */
  expanded?: boolean;
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

export interface ThinkingBlock {
  kind: "thinking";
  content: string;
  timestamp: number;
}

export interface UserMessageBlock {
  kind: "userMessage";
  content: string;
  timestamp: number;
  /** True while the message has been written to stdin but the agent hasn't picked it up yet. */
  pending?: boolean;
}

export type AnyBlock = TextBlock | ToolBlock | AgentBlock | ContextGroupBlock | SystemBlock | ThinkingBlock | UserMessageBlock;

// ---------------------------------------------------------------------------
// Split state types — ExecutionState and OutputState are independent stores
// composed behind the UIActions facade. WorkState is their union (backward compat).
// ---------------------------------------------------------------------------

/** Workflow lifecycle, queue steps, approval, navigation, error. */
export interface ExecutionState {
  planName: string;
  version: string;
  startTime: number;
  endTime?: number;
  workflowStatus: WorkflowStatus;
  /** Queue step display states for the workflow panel. */
  queueSteps: QueueStepState[];
  approvalState: ApprovalState;
  selectedStepIndex: number;
  scrollOffset: number;
  visibleItemCount: number;
  error?: string;
  modelActivity: "idle" | "thinking" | "generating" | "tool_executing";
}

/** Structured output blocks and legacy output lines. */
export interface OutputState {
  /**
   * @deprecated Prefer `outputBlocks` for display. `outputLines` is retained
   * for the console adapter and raw-mode passthrough. The OpenTUI adapter now
   * routes all output (including system messages and stderr) through the
   * structured block pipeline.
   */
  outputLines: OutputLine[];
  outputBlocks: AnyBlock[];
}

/** Combined state — backward compatible union of ExecutionState + OutputState. */
export interface WorkState extends ExecutionState, OutputState {}

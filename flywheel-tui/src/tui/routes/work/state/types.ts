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
  status: "active" | "completed" | "error";
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
  phases: PhaseState[];
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

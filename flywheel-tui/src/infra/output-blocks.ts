/**
 * Output Block Types
 *
 * Pure data shapes for structured output blocks used by both the
 * orchestration layer (persistence, session registry) and the TUI layer
 * (rendering). Lives in infra/ so both layers can import without
 * crossing module boundaries.
 */

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

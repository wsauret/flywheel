/**
 * Work State Types
 *
 * Core state types for the Flywheel workflow TUI.
 * These are the "source of truth" shapes used by the store and actions.
 */

export type WorkflowStatus = "idle" | "running" | "completed" | "failed" | "interrupted" | "stopping";

// ── Structured Output Blocks (canonical definitions in infra/output-blocks.ts) ──

export type {
  TextBlock,
  ToolBlock,
  AgentBlock,
  ContextGroupBlock,
  SystemBlock,
  ThinkingBlock,
  UserMessageBlock,
  TodoItem,
  TodoListBlock,
  AnyBlock,
} from "../infra/output-blocks";

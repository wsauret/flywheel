/**
 * Type definitions for subagent lifecycle event tracking.
 * Defines interfaces for parsing and tracking Claude Code subagent spawns,
 * completions, and errors from JSONL output.
 */

/**
 * Types of subagent lifecycle events.
 * - 'spawn': Subagent was started (Task tool invocation)
 * - 'complete': Subagent finished successfully
 * - 'error': Subagent encountered an error
 */
export type SubagentEventType = 'spawn' | 'complete' | 'error';

/**
 * Base interface for all subagent events.
 */
export interface SubagentEventBase {
  /** Unique identifier for this subagent instance */
  id: string;

  /** Type of lifecycle event */
  type: SubagentEventType;

  /** Timestamp when the event occurred (ISO 8601) */
  timestamp: string;

  /** Type of agent being used (e.g., 'Explore', 'Bash', 'Plan') */
  agentType: string;

  /** Human-readable description of what the subagent is doing */
  description: string;

  /** ID of the parent subagent if this is a nested call, undefined for top-level */
  parentId?: string;
}

/**
 * Event emitted when a subagent is spawned via the Task tool.
 */
export interface SubagentSpawnEvent extends SubagentEventBase {
  type: 'spawn';

  /** The prompt/task given to the subagent */
  prompt: string;

  /** Model being used (if specified) */
  model?: string;
}

/**
 * Event emitted when a subagent completes successfully.
 */
export interface SubagentCompleteEvent extends SubagentEventBase {
  type: 'complete';

  /** Exit status: 'success' or other status string */
  exitStatus: string;

  /** Duration of the subagent execution in milliseconds */
  durationMs: number;

  /** Summary of what the subagent accomplished */
  result?: string;
}

/**
 * Event emitted when a subagent encounters an error.
 */
export interface SubagentErrorEvent extends SubagentEventBase {
  type: 'error';

  /** Error message */
  errorMessage: string;

  /** Error code if available */
  errorCode?: string;

  /** Duration before error in milliseconds */
  durationMs?: number;
}

/**
 * Union of all subagent event types.
 */
export type SubagentEvent =
  | SubagentSpawnEvent
  | SubagentCompleteEvent
  | SubagentErrorEvent;

/**
 * Callback function for receiving subagent events in real-time.
 */
export type SubagentEventCallback = (event: SubagentEvent) => void;

/**
 * State of a tracked subagent.
 */
export interface SubagentState {
  /** Unique identifier for this subagent */
  id: string;

  /** Type of agent */
  agentType: string;

  /** Description of the task */
  description: string;

  /** Current status */
  status: 'running' | 'completed' | 'error';

  /** Parent subagent ID if nested */
  parentId?: string;

  /** Child subagent IDs */
  childIds: string[];

  /** Timestamp when spawned */
  spawnedAt: string;

  /** Timestamp when completed/errored */
  endedAt?: string;

  /** Duration in milliseconds (computed when ended) */
  durationMs?: number;

  /** The prompt given to the subagent */
  prompt?: string;

  /** Result or error message */
  result?: string;
}

/**
 * Options for the SubagentTraceParser.
 */
export interface SubagentTraceParserOptions {
  /** Callback for real-time event updates */
  onEvent?: SubagentEventCallback;

  /** Whether to track parent-child hierarchy (default: true) */
  trackHierarchy?: boolean;
}

/**
 * Summary of subagent activity from a trace.
 */
export interface SubagentTraceSummary {
  /** Total number of subagents spawned */
  totalSpawned: number;

  /** Number of subagents that completed successfully */
  completed: number;

  /** Number of subagents that errored */
  errored: number;

  /** Number of subagents still running */
  running: number;

  /** Maximum nesting depth observed */
  maxDepth: number;

  /** Total duration of all completed subagents */
  totalDurationMs: number;

  /** Map of agent type to count */
  byAgentType: Record<string, number>;
}

/**
 * Minimal Claude JSONL message shape consumed by the parser.
 * Defines only the fields the subagent tracing layer needs, rather than
 * importing the full Claude output type.
 */
export interface ClaudeJsonlMessage {
  type?: string;
  tool?: { name?: string; input?: Record<string, unknown> };
  result?: string;
  raw: Record<string, unknown>;
}

/**
 * Tool names that indicate a subagent spawn (matched case-insensitively).
 *
 * Claude Code uses two names depending on the agent type:
 * - "Task" — user-dispatched subagents (e.g., from the Task tool in prompts)
 * - "Agent" — Claude Code's built-in agents (Explore, Plan, etc.)
 *
 * Both produce the same lifecycle: spawn → child tool calls → tool_result.
 */
const SUBAGENT_TOOL_NAMES = new Set(["task", "agent"]);

/**
 * Check if a tool name represents a subagent spawn.
 */
export function isSubagentToolName(name: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(name.toLowerCase());
}

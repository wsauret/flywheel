import type { NDJSONEvent, UserEventToolResult } from "../../../infra/ndjson-event-types.js";
import type { ToolAction } from "../../../infra/workflow-types.js";

export interface EngineParityMetadata {
  resumeMode: "provider_session" | "local_transcript";
  handoffMode: "generic_file_write" | "dedicated_handoff_tool";
  progressMode: "builtin_todo" | "stateful_progress_tool";
  toolExecutionMode: "provider_native" | "shell_emulated";
  taskScopeMode: "subagent" | "progress_tool";
  supportsExternalToolResults: boolean;
}

export interface EngineMetadata {
  /** Unique identifier (e.g., "claude", "harness") */
  id: string;
  /** Display name (e.g., "Claude Code", "Flywheel Harness") */
  name: string;
  /** Default model for this engine */
  defaultModel: string;
  /** Display description */
  description: string;
  /** Structured parity notes for cross-engine comparisons. */
  parity: EngineParityMetadata;
  /**
   * When set, the engine delivers thinking as complete blocks rather than
   * streaming tokens. The adapter will emit a synthetic "thinking" activity
   * event after this many milliseconds of silence following tool/text output,
   * so the TUI can show a live indicator while the model processes.
   *
   * Omit for engines that stream thinking tokens natively — they drive the
   * "thinking" activity signal directly via their output.
   */
  syntheticThinkingMs?: number;
  /**
   * Engine benefits from pre-spawning processes for short-lived tier
   * invocations (dispatcher, evaluator). When true, the orchestration layer
   * creates warm pools for tiers assigned to this engine.
   *
   * CLI-based engines (Claude) set this; in-process engines omit it.
   */
  supportsPooling?: boolean;
}

export interface RunnerOptions {
  model: string;
  systemPrompt?: string;
  effort?: string;
  handoffPath?: string;
  /** Absolute path to the session directory (`.flywheel/sessions/<id>`).
   *  Used by the harness engine for conversation persistence across reconnects. */
  sessionDir?: string;
  /** Resume a prior engine session instead of starting fresh. */
  resumeSessionId?: string;
  /** Engine-agnostic tool actions resolved at the engine boundary. */
  toolActions?: ReadonlyArray<ToolAction>;
  /** Provider-native tool restriction kept for low-level callers. */
  tools?: ReadonlyArray<string>;
  cwd: string;
  /** Called for each event the engine produces (NDJSONEvent objects). */
  onEvent: (event: NDJSONEvent) => void;
  /**
   * Called when the model yields control to the user — no more tool calls,
   * ready for the next user message. Same semantics in all engines.
   */
  onTurnComplete?: () => void;
  /** External abort signal. */
  signal?: AbortSignal;
  /**
   * Extra env vars to inject into the subprocess. Claude engine forwards these
   * to the CLI child so our ask-hook (and future hooks) can find IPC endpoints.
   */
  extraEnv?: Record<string, string>;
  /**
   * Additional CLI settings as a JSON string. Claude engine forwards as
   * `--settings <json>`. Used to register per-session hooks.
   */
  claudeSettings?: string;
}

export interface EngineRunner {
  /** Send a user message. First call starts execution; subsequent calls are multi-turn follow-ups. */
  send(text: string): void;
  /** Deliver an out-of-band tool result. Only engines that accept external tool execution implement this. */
  sendToolResult?(toolResult: UserEventToolResult): void;
  /** Signal end-of-input: caller will not send() again. Runner finishes current turn then resolves `done`. */
  end(): void;
  /** Abort current turn or entire execution. */
  abort(): void;
  /** Resolves when the runner has completed all processing. */
  readonly done: Promise<EngineResult>;
}

export interface EngineResult {
  durationMs: number;
  sessionId?: string;
  failure?: EngineFailureReason;
}

export type EngineFailureReason =
  | { kind: "context_overflow" }
  | { kind: "budget_exhausted" }
  | { kind: "output_overflow" }
  | { kind: "api_error"; message: string }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "exit_code"; code: number };

export interface Engine {
  metadata: EngineMetadata;
  /** Create a runner for executing within this engine. */
  createRunner(options: RunnerOptions): EngineRunner;
}

/** Normalized event shape consumed by stream observers. Engine-agnostic. */
export type EngineEvent =
  | { type: "tool_use"; toolName: string; toolInput: Record<string, unknown> }
  | { type: "tool_result"; isError: boolean }
  | { type: "text" }
  | { type: "result" }
  | { type: "other" };
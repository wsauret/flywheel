import type { NDJSONEvent, UserEventToolResult } from "../../../infra/ndjson-event-types.js";
import type { ToolAction } from "../../../infra/workflow-types.js";
import type { AuthContext } from "../../../infra/auth/auth-context.js";
import type { AgentDefinition } from "../providers/harness/agent-loader.js";

interface EngineParityMetadata {
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
  /**
   * Harness-native tool names (e.g. "read", "bash", "edit") when the caller
   * already knows which tools to enable. Used by the subagent runner so it
   * can honor an agent's declared `tools: [...]` list without round-tripping
   * through the CLI-name or ToolAction resolver. Preferred by callers that
   * already speak harness semantics.
   */
  engineToolNames?: ReadonlyArray<string>;
  cwd: string;
  /** Called for each event the engine produces (NDJSONEvent objects). */
  onEvent: (event: NDJSONEvent) => void;
  /**
   * Called when the model yields control to the user — no more tool calls,
   * ready for the next user message. Returns a message to inject (keeping
   * the loop alive) or null to end. Harness uses the return value directly;
   * subprocess engines rely on in-callback side effects (stdin write/close).
   */
  onTurnComplete?: () => string | null;
  /**
   * Called after each tool-execution batch completes. Returns a message to
   * inject as the next user message, or null to proceed unchanged. Worker
   * layer uses this as the double-confirm handoff boundary by filtering on
   * tool names internally — the loop stays tool-agnostic.
   */
  onPostToolBatch?: (toolNames: readonly string[], errors: readonly boolean[]) => string | null;
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
  /**
   * Auth context resolved from config + environment. The harness engine needs this
   * to pick the right access-provider (API key vs ChatGPT OAuth). Other engines
   * may ignore it.
   */
  auth?: AuthContext;
  // Queue access: the chat/workflow layer owns the queue so there is one
  // source of truth for what is pending. Runner reads at turn boundaries.
  takeNextQueued?: () => string | null;
  hasQueuedInput?: () => boolean;
  drainQueued?: () => string[];
  /**
   * Marks this runner as a nested (subagent) execution whose emitted events
   * should be tagged with `parent_tool_use_id`. Harness-only. When present,
   * `emitAssistant`, `emitToolResult`, `emitContentBlockDelta`, and
   * `emitResult` attach this id so the TUI routes output to the subagent
   * group rather than the top-level stream. User messages stay top-level.
   */
  parentToolUseId?: string;
  /**
   * Per-runner LLM call ceiling. When set, overrides the engine's default
   * (harness default: DEFAULT_MAX_LLM_CALLS, 200 at the time of writing).
   * Subagents pass `agent.maxTurns` here so each agent honors its own cap.
   */
  maxLLMCalls?: number;
  /**
   * Path resolver for the conversation JSONL file.
   * String form: a literal path used verbatim.
   * Function form: called with the runner's internal session UUID. Callers
   * that require a stable, externally-determined path (e.g. subagent keyed
   * on toolCallId) MUST ignore the `sessionId` argument and return their
   * own path. The argument exists only to support callers that derive the
   * path from the session ID.
   * Omit to fall back to the engine default (`conversations/<sessionId>.jsonl`).
   */
  conversationPath?: string | ((sessionId: string) => string);
  /**
   * Pre-resolved agent registry. When supplied, the runner skips its own
   * filesystem lookup. Subagents reuse the parent harness loop's registry
   * so a nested run never rescans `~/.flywheel/agents`.
   */
  agentRegistry?: Map<string, AgentDefinition>;
  /**
   * Pre-resolved project instructions. When supplied, the runner skips
   * `loadProjectInstructions(cwd)`. Subagents pass the parent's cached value.
   */
  projectInstructions?: string;
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
  /**
   * Remove and return any queued user inputs that have not yet been consumed.
   * Used on interrupt to recover messages that would otherwise be lost when a
   * new runner takes over. Engines without an internal queue can omit this.
   */
  drainPendingInputs?(): string[];
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
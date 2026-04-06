/**
 * Engine abstraction types.
 *
 * Adapted from CodeMachine's engine pattern. Each engine (claude, opencode, etc.)
 * provides metadata and a command builder. The model is just a string passed through.
 */

export interface EngineMetadata {
  /** Unique identifier (e.g., "claude", "opencode") */
  id: string;
  /** Display name (e.g., "Claude Code", "OpenCode") */
  name: string;
  /** The CLI binary to execute */
  cliBinary: string;
  /** Default model for this engine */
  defaultModel: string;
  /** Install instructions */
  installCommand: string;
  /** Display description */
  description: string;
  /** Display order in UI (lower = first) */
  order?: number;
  /**
   * Whether this engine enforces tool scoping via CLI flags (true)
   * or only via prompt-based instructions (false).
   */
  supportsToolScoping: boolean;
  /**
   * Whether this engine supports streaming input via stdin pipe
   * (e.g., Claude's `--input-format stream-json`).
   *
   * When true, the worker spawner uses `stdinPipe: true` and wraps the
   * StdinHandle with engine-specific message formatting.
   *
   * When false (e.g., OpenCode SDK path), stdin injection is handled
   * internally by the spawner (SdkSpawner).
   */
  supportsStreamingInput: boolean;
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
}

export interface EngineCommand {
  command: string;
  args: string[];
  /** Whether the prompt should be passed via stdin (true) or is already in args */
  stdinPrompt: boolean;
  /**
   * Optional prompt prefix for engines that enforce tool scoping via prompt instructions
   * rather than CLI flags. Callers should prepend this to the prompt before passing via stdin.
   */
  promptPrefix?: string;
}

/**
 * Tool scoping shape — controls which tool categories the worker can use.
 * Defined inline to avoid engine types depending on Zod schemas at runtime.
 */
export interface ToolScopingConfig {
  read: boolean;
  bash: boolean;
  write: boolean;
  edit: boolean;
  /** When true, the worker can dispatch sub-agents via the Task tool. */
  task?: boolean;
}

export interface EngineCommandOptions {
  /** Model override (engine-native format, e.g., "opus" for claude, "anthropic/claude-opus-4-6" for opencode) */
  model?: string;
  /** Session ID to resume (worker resume path) */
  resumeSessionId?: string;
  /** Tool scoping restrictions — controls which tool categories the worker can access */
  toolScoping?: ToolScopingConfig;
  /** Explicit tools string for dispatcher/evaluator (e.g., "Write", "Read,Bash,Write,Grep,Glob") */
  tools?: string;
  /** System prompt (separate from user prompt for caching, passed as --system-prompt flag) */
  systemPrompt?: string;
  /** Effort level override (e.g., "low", "medium", "high") */
  effort?: string;
}

export interface ModelInfo {
  /** Model ID in the engine's native format (e.g., "opus", "anthropic/claude-opus-4-6") */
  id: string;
  /** Human-readable display name (e.g., "Claude Opus 4.6") */
  name: string;
  /** Model family for grouping (e.g., "opus", "sonnet", "haiku") */
  family: string;
  /** Whether this is an alias (e.g., "opus") vs a dated version */
  isAlias: boolean;
}

export interface Engine {
  metadata: EngineMetadata;
  /**
   * Build the CLI command + args for execution.
   *
   * Unified builder used by all roles (worker, dispatcher, evaluator).
   * All roles use --input-format stream-json with stdin pipes.
   */
  buildCommand(options: EngineCommandOptions): EngineCommand;
  /**
   * List available models.
   * @param provider - Optional provider filter (e.g., "anthropic"). If omitted, returns all.
   */
  listModels(provider?: string): Promise<ModelInfo[]>;
}

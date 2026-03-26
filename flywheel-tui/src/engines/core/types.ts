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
}

export interface EngineCommandOptions {
  /** The prompt to execute */
  prompt: string;
  /** Model override (engine-native format, e.g., "opus" for claude, "anthropic/claude-opus-4-6" for opencode) */
  model?: string;
  /** Session ID to resume */
  resumeSessionId?: string;
  /** Tool scoping restrictions — controls which tool categories the worker can access */
  toolScoping?: ToolScopingConfig;
}

/**
 * Options for building a dispatcher/evaluator command.
 *
 * Dispatcher commands are optimized for speed: tools disabled, fast model,
 * separate system prompt for caching, no session persistence.
 */
export interface DispatcherCommandOptions {
  /** The user prompt to send */
  prompt: string;
  /** System prompt (separate from user prompt for caching) */
  systemPrompt: string;
  /** Model override — defaults to a Sonnet-class model per engine */
  model?: string;
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
  /** Build the CLI command + args for worker execution */
  buildCommand(options: EngineCommandOptions): EngineCommand;
  /**
   * Build a CLI command optimized for dispatcher/evaluator use.
   *
   * Dispatcher commands disable tools, use a fast model, pass a separate
   * system prompt for caching, and disable session persistence.
   */
  buildDispatcherCommand(options: DispatcherCommandOptions): EngineCommand;
  /**
   * List available models.
   * @param provider - Optional provider filter (e.g., "anthropic"). If omitted, returns all.
   */
  listModels(provider?: string): Promise<ModelInfo[]>;
}

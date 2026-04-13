/**
 * Engine abstraction types.
 *
 * Adapted from CodeMachine's engine pattern. Each engine (claude, opencode, etc.)
 * provides metadata and a command builder. The model is just a string passed through.
 */

import type { ToolScoping } from "../../../infra/workflow-types.js";

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

// ToolScoping is imported from infra/workflow-types.ts — single source of truth.

export interface EngineCommandOptions {
  /** Model override (engine-native format, e.g., "opus" for claude, "anthropic/claude-opus-4-6" for opencode) */
  model?: string;
  /** Session ID to resume (worker resume path) */
  resumeSessionId?: string;
  /** Tool scoping restrictions — controls which tool categories the worker can access */
  toolScoping?: ToolScoping;
  /** Explicit tools string for dispatcher/evaluator (e.g., "Write", "Read,Bash,Write,Grep,Glob") */
  tools?: string;
  /** System prompt (separate from user prompt for caching, passed as --system-prompt flag) */
  systemPrompt?: string;
  /** Effort level override (e.g., "low", "medium", "high") */
  effort?: string;
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
}

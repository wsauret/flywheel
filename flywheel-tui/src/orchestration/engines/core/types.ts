import type { NDJSONEvent } from "../../../infra/ndjson-event-types.js";

export interface EngineMetadata {
  /** Unique identifier (e.g., "claude", "harness") */
  id: string;
  /** Display name (e.g., "Claude Code", "Flywheel Harness") */
  name: string;
  /** Default model for this engine */
  defaultModel: string;
  /** Display description */
  description: string;
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
  /** Resume a prior engine session instead of starting fresh. */
  resumeSessionId?: string;
  /** Explicit tool restriction (e.g. ["Write"] or ["Read", "Bash", "Write", "Grep", "Glob"]).
   *  Claude engine maps to --tools flag; harness engine uses for dispatch filtering. */
  tools?: ReadonlyArray<string>;
  cwd: string;
  /** Called for each event the engine produces (NDJSONEvent objects). */
  onEvent: (event: NDJSONEvent) => void;
  /**
   * Called when a turn completes (agent finished, ready for next message).
   * For harness (in-process), fires immediately after the result event.
   * For CLI engines, bridges the gap between result event and stdin readiness.
   */
  onTurnComplete?: () => void;
  /** External abort signal. */
  signal?: AbortSignal;
}

export interface EngineRunner {
  /** Send a message. First call starts execution; subsequent calls are multi-turn follow-ups. */
  send(text: string): void;
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
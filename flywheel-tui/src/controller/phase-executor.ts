/**
 * PhaseExecutor — wraps worker spawn with retry logic.
 *
 * Uses the engine pattern (from CodeMachine) to build CLI commands.
 * Prompt is passed via stdin. Model is a passthrough string.
 *
 * Emits worker events via FlywheelEmitter.
 */

import type { ProcessSpawner, StdinHandle } from "../worker/spawner";
import type { WorkerResult } from "../schemas/worker";
import type { FlywheelEmitter } from "../events/event-bus";
import type { FlywheelConfig } from "../config/loader";
import type { Engine } from "../engines/core/types";
import type { ToolScoping } from "../schemas/shared";
import { isRetryable } from "../worker/errors";
import { RATE_LIMIT_RETRY_OPTIONS } from "../worker/rate-limit";
import { retry } from "../utils/retry";
import { Log } from "../utils/log";
import { SubprocessLogger, createLoggedCallbacks } from "../utils/subprocess-logger.js";

const log = Log.create({ service: "phase-executor" });

// ---------------------------------------------------------------------------
// Claude stdin message formatting (SDKUserMessage NDJSON)
// ---------------------------------------------------------------------------

/**
 * Format a text message as Claude's SDKUserMessage NDJSON.
 *
 * When Claude is running with `--input-format stream-json`, all stdin
 * messages (including the initial prompt) must be wrapped in this format.
 */
export function formatClaudeStdinMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

/**
 * Create a wrapping StdinHandle that formats messages for the target engine.
 *
 * For Claude: wraps each write() call with SDKUserMessage NDJSON formatting.
 * For other engines: returns the raw handle unchanged (SDK spawner handles
 * formatting internally).
 */
function createFormattingStdinHandle(raw: StdinHandle, engine: Engine): StdinHandle {
  if (engine.metadata.supportsStreamingInput) {
    return {
      write: (msg: string) => raw.write(formatClaudeStdinMessage(msg)),
      close: () => raw.close(),
      get isOpen() { return raw.isOpen; },
    };
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PhaseExecutorOptions {
  spawner: ProcessSpawner;
  emitter: FlywheelEmitter;
  config: FlywheelConfig;
  engine: Engine;
  workflowId: string;
  /** Fallback engines to try when the primary engine exhausts retries with rate_limited. */
  fallbackEngines?: Engine[];
}

export interface ExecutePhaseOptions {
  phaseIndex: number;
  prompt: string;
  /** Working directory for the worker */
  cwd?: string;
  /** Called with each decoded stdout chunk as it arrives */
  onStdout?: (chunk: string) => void;
  /** Called with each decoded stderr chunk as it arrives */
  onStderr?: (chunk: string) => void;
  /** Abort signal — when fired, worker is interrupted (not retried) */
  signal?: AbortSignal;

  /** Session ID to resume (for revision re-spawns) */
  resumeSessionId?: string;

  // --- Dispatcher decision overrides (take precedence over FlywheelConfig) ---

  /** Override timeout in milliseconds (from dispatcher worker_config.timeout_minutes) */
  timeoutOverrideMs?: number;
  /** Override the model for this phase (from dispatcher worker_config.model_override) */
  modelOverride?: string;
  /** Override max retries for this phase (from dispatcher worker_config.max_retries) */
  maxRetriesOverride?: number;
  /** Tool scoping restrictions for this phase (from dispatcher worker_config.tool_scoping) */
  toolScoping?: ToolScoping;
  /** Iteration budget for this phase (from dispatcher worker_config.iteration_budget) */
  iterationBudget?: number;
  /** Unique invocation ID for handoff file path construction */
  invocationId?: string;
  /** Base directory for subprocess JSONL logging. When set, all stdout/stderr is logged. */
  logBaseDir?: string;
}

// ---------------------------------------------------------------------------
// PhaseExecutor
// ---------------------------------------------------------------------------

export class PhaseExecutor {
  private readonly spawner: ProcessSpawner;
  private readonly emitter: FlywheelEmitter;
  private readonly config: FlywheelConfig;
  private readonly engine: Engine;
  private readonly workflowId: string;
  private readonly fallbackEngines: Engine[];
  /** Stdin handle for the currently active spawn (replaced on retry). */
  private _currentStdinHandle: StdinHandle | undefined;

  constructor(options: PhaseExecutorOptions) {
    this.spawner = options.spawner;
    this.emitter = options.emitter;
    this.config = options.config;
    this.engine = options.engine;
    this.workflowId = options.workflowId;
    this.fallbackEngines = options.fallbackEngines ?? [];
  }

  /**
   * Get the stdin handle for the currently active spawn.
   * Returns undefined if no spawn is active or stdin pipe was not requested.
   *
   * Wired through ExecutionLoop.injectToWorker() → shell's activeLoop for
   * mid-execution stdin injection during both work and generic stages.
   *
   * Note: OpenCode engine has supportsStreamingInput: false, so stdin
   * injection only works for Claude workers (which use --input-format stream-json).
   * OpenCode workers receive the initial prompt via stdin but do not accept
   * additional messages after startup.
   */
  getStdinHandle(): StdinHandle | undefined {
    return this._currentStdinHandle;
  }

  /**
   * Execute a phase by spawning a worker with retry logic.
   *
   * Tries the primary engine first. If all retries are exhausted with a
   * `rate_limited` failure and fallback engines are configured, tries each
   * fallback engine in order. Fallback switching is immediate (no delay).
   *
   * @returns WorkerResult on success
   * @throws Error if all engines (primary + fallbacks) are exhausted or failure is non-retryable
   */
  async execute(options: ExecutePhaseOptions): Promise<WorkerResult> {
    try {
      return await this.executeWithEngine(this.engine, options);
    } catch (error) {
      // Only trigger fallback chain on rate_limited final failure
      if (!this.isRateLimitedError(error) || this.fallbackEngines.length === 0) {
        throw error;
      }

      // Try each fallback engine in order (immediate switching, no delay)
      let lastError: unknown = error;
      for (const fallbackEngine of this.fallbackEngines) {
        try {
          return await this.executeWithEngine(fallbackEngine, options);
        } catch (fallbackError) {
          lastError = fallbackError;
          // Only continue to next fallback if this one also rate-limited
          if (!this.isRateLimitedError(fallbackError)) {
            throw fallbackError;
          }
        }
      }

      // All fallbacks exhausted
      throw lastError;
    }
  }

  /**
   * Execute a phase using a specific engine, with retry logic.
   */
  private async executeWithEngine(
    engine: Engine,
    options: ExecutePhaseOptions,
  ): Promise<WorkerResult> {
    const {
      phaseIndex, prompt, cwd, onStdout, onStderr, signal,
      timeoutOverrideMs, modelOverride, maxRetriesOverride, toolScoping,
      resumeSessionId, invocationId, logBaseDir,
    } = options;

    // Build command using the engine pattern — dispatcher model override takes precedence
    const model = modelOverride ?? this.config.worker?.model ?? this.config.model;
    const engineCmd = engine.buildCommand({ prompt, model, toolScoping, resumeSessionId });

    // If the engine returned a promptPrefix (e.g. OpenCode prompt-based scoping),
    // prepend it to the prompt that will be sent via stdin.
    let effectivePrompt = engineCmd.promptPrefix
      ? `${engineCmd.promptPrefix}\n\n${prompt}`
      : prompt;

    // For streaming input engines (Claude with --input-format stream-json),
    // wrap the initial prompt in SDKUserMessage NDJSON format.
    const useStreamingInput = engine.metadata.supportsStreamingInput;
    if (useStreamingInput) {
      effectivePrompt = formatClaudeStdinMessage(effectivePrompt);
    }

    // Dispatcher overrides take precedence over config
    const maxRetries = maxRetriesOverride ?? this.config.max_retries;
    const timeoutMs = timeoutOverrideMs ?? this.config.timeout_minutes * 60_000;

    if (timeoutOverrideMs != null) {
      log.info("using dispatcher timeout override", {
        phaseIndex,
        timeoutMs: timeoutOverrideMs,
      });
    }
    if (maxRetriesOverride != null) {
      log.info("using dispatcher max_retries override", {
        phaseIndex,
        maxRetries: maxRetriesOverride,
      });
    }
    if (modelOverride) {
      log.info("using dispatcher model override", {
        phaseIndex,
        model: modelOverride,
      });
    }
    if (toolScoping) {
      log.info("applying tool scoping", {
        phaseIndex,
        toolScoping,
        enforcement: engine.metadata.supportsToolScoping ? "cli" : "prompt",
      });
    }

    // Create subprocess logger if logBaseDir is configured
    const spLogger = logBaseDir && invocationId
      ? new SubprocessLogger({ baseDir: logBaseDir, role: "worker", invocationId })
      : null;
    const { onStdout: effectiveOnStdout, onStderr: effectiveOnStderr } = spLogger
      ? createLoggedCallbacks(spLogger, { onStdout, onStderr })
      : { onStdout, onStderr };

    // Emit worker spawned for the initial attempt
    this.emitter.workerSpawned(this.workflowId, phaseIndex, 0);

    try {
      const retryResult = await retry<WorkerResult>(
        async () => {
          let workerResult: WorkerResult;
          try {
            const spawnResult = await this.spawner.spawn(
              engineCmd.command,
              engineCmd.args,
              {
                cwd,
                timeoutMs,
                stdin: engineCmd.stdinPrompt ? effectivePrompt : undefined,
                onStdout: effectiveOnStdout,
                onStderr: effectiveOnStderr,
                signal,
                stdinPipe: useStreamingInput,
                invocationId,
              },
            );
            // Store stdin handle for this spawn (replaced on retry).
            // For streaming input engines, wrap with formatting layer.
            this._currentStdinHandle = spawnResult.stdinHandle
              ? createFormattingStdinHandle(spawnResult.stdinHandle, engine)
              : spawnResult.stdinHandle;
            workerResult = await spawnResult.result;
          } catch (error) {
            const err = error as { code?: string; message?: string };
            const isNotFound =
              err?.code === "ENOENT" ||
              /command not found/i.test(err?.message ?? "") ||
              /not recognized/i.test(err?.message ?? "");

            if (isNotFound) {
              const meta = engine.metadata;
              throw new Error(
                `'${meta.cliBinary}' is not available on this system. Install ${meta.name}:\n  ${meta.installCommand}`,
              );
            }
            throw error;
          }

          // If there's a failure, throw to trigger retry logic
          if (workerResult.failure) {
            const err = new WorkerError(workerResult);
            throw err;
          }

          return workerResult;
        },
        {
          maxRetries,
          backoff: "exponential",
          baseDelayMs: 1000,
          maxDelayMs: RATE_LIMIT_RETRY_OPTIONS.maxDelayMs,
          jitter: true,
          isRetryable: (error) => {
            if (error instanceof WorkerError && error.result.failure) {
              return isRetryable(error.result.failure);
            }
            return false;
          },
          onRetry: (attempt, error, delayMs) => {
            const reason =
              error instanceof WorkerError && error.result.failure
                ? error.result.failure.message
                : String(error);

            if (error instanceof WorkerError && error.result.failure?.kind === "rate_limited") {
              log.info("rate-limited, retrying with exponential backoff", {
                attempt,
                delayMs,
                rateLimitBaseDelayMs: RATE_LIMIT_RETRY_OPTIONS.baseDelayMs,
              });
            }

            this.emitter.workerRetrying(
              this.workflowId,
              attempt,
              maxRetries,
              reason,
            );
          },
        },
      );

      // Unwrap RetryResult — re-throw on failure to preserve PhaseExecutor contract
      if (!retryResult.success) {
        throw retryResult.error;
      }

      const result = retryResult.value!;

      // Emit worker completed
      this.emitter.workerCompleted(this.workflowId, result);
      return result;
    } finally {
      spLogger?.close();
    }
  }

  /**
   * Check if an error is a rate-limited WorkerError (explicitly checks failure.kind).
   */
  private isRateLimitedError(error: unknown): boolean {
    return (
      error instanceof WorkerError &&
      error.result.failure?.kind === "rate_limited"
    );
  }
}

// ---------------------------------------------------------------------------
// Internal error wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps a WorkerResult that has a failure, allowing retry() to catch it.
 */
export class WorkerError extends Error {
  readonly result: WorkerResult;

  constructor(result: WorkerResult) {
    super(result.failure?.message ?? "Worker failed");
    this.name = "WorkerError";
    this.result = result;
  }
}

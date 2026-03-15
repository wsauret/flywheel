/**
 * PhaseExecutor — wraps worker spawn with retry logic.
 *
 * Uses the engine pattern (from CodeMachine) to build CLI commands.
 * Prompt is passed via stdin. Model is a passthrough string.
 *
 * Emits worker events via FlywheelEmitter.
 */

import type { ProcessSpawner } from "../worker/spawner";
import type { WorkerResult } from "../schemas/worker";
import type { FlywheelEmitter } from "../events/event-bus";
import type { FlywheelConfig } from "../config/loader";
import type { Engine } from "../engines/core/types";
import { isRetryable } from "../worker/errors";
import { retry } from "../utils/retry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PhaseExecutorOptions {
  spawner: ProcessSpawner;
  emitter: FlywheelEmitter;
  config: FlywheelConfig;
  engine: Engine;
  workflowId: string;
}

export interface ExecutePhaseOptions {
  phaseIndex: number;
  prompt: string;
  /** Working directory for the worker */
  cwd?: string;
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

  constructor(options: PhaseExecutorOptions) {
    this.spawner = options.spawner;
    this.emitter = options.emitter;
    this.config = options.config;
    this.engine = options.engine;
    this.workflowId = options.workflowId;
  }

  /**
   * Execute a phase by spawning a worker with retry logic.
   *
   * @returns WorkerResult on success
   * @throws Error if all retries are exhausted or failure is non-retryable
   */
  async execute(options: ExecutePhaseOptions): Promise<WorkerResult> {
    const { phaseIndex, prompt, cwd } = options;

    // Build command using the engine pattern (worker tier model)
    const engineCmd = this.engine.buildCommand({
      prompt,
      model: this.config.worker?.model ?? this.config.model,
    });

    const maxRetries = this.config.max_retries;
    const timeoutMs = this.config.timeout_minutes * 60_000;

    // Emit worker spawned for the initial attempt
    this.emitter.workerSpawned(this.workflowId, phaseIndex, 0);

    const retryResult = await retry<WorkerResult>(
      async () => {
        let workerResult: WorkerResult;
        try {
          workerResult = await this.spawner.spawn(
            engineCmd.command,
            engineCmd.args,
            {
              cwd,
              timeoutMs,
              stdin: engineCmd.stdinPrompt ? prompt : undefined,
            },
          );
        } catch (error) {
          const err = error as { code?: string; message?: string };
          const isNotFound =
            err?.code === "ENOENT" ||
            /command not found/i.test(err?.message ?? "") ||
            /not recognized/i.test(err?.message ?? "");

          if (isNotFound) {
            const meta = this.engine.metadata;
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
        maxDelayMs: 120_000,
        jitter: true,
        isRetryable: (error) => {
          if (error instanceof WorkerError && error.result.failure) {
            return isRetryable(error.result.failure);
          }
          return false;
        },
        onRetry: (attempt, error, _delayMs) => {
          const reason =
            error instanceof WorkerError && error.result.failure
              ? error.result.failure.message
              : String(error);

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

/**
 * Evaluator — checks worker output quality and can request re-prompts.
 *
 * Max 2 evaluation cycles for failures. Timeouts skip evaluation (proceed).
 * Skippable via config flag.
 */

import type { EvaluatorTransport } from "./transport";
import type { EvaluatorResult } from "../schemas/evaluator";
import type { FlywheelEmitter } from "../events/event-bus";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CYCLES = 2;
const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvaluatorOptions {
  transport: EvaluatorTransport;
  emitter: FlywheelEmitter;
  workflowId: string;
  skipEvaluation?: boolean;
  timeoutMs?: number;
  /** Phase/step indices for event emission. Defaults to 0. */
  phaseIndex?: number;
  stepIndex?: number;
}

export interface EvaluationResult {
  passed: boolean;
  cyclesUsed: number;
  skipped: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export class Evaluator {
  private readonly transport: EvaluatorTransport;
  private readonly emitter: FlywheelEmitter;
  private readonly workflowId: string;
  private readonly skipEvaluation: boolean;
  private readonly timeoutMs: number;
  private readonly phaseIndex: number;
  private readonly stepIndex: number;

  constructor(options: EvaluatorOptions) {
    this.transport = options.transport;
    this.emitter = options.emitter;
    this.workflowId = options.workflowId;
    this.skipEvaluation = options.skipEvaluation ?? false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.phaseIndex = options.phaseIndex ?? 0;
    this.stepIndex = options.stepIndex ?? 0;
  }

  /**
   * Evaluate worker output. Max 2 cycles.
   * Timeouts don't count against the cycle cap.
   */
  async evaluate(
    workerOutput: string,
    validationCriteria: string,
    contextFiles: string[],
  ): Promise<EvaluationResult> {
    // Skip evaluation if configured
    if (this.skipEvaluation) {
      return { passed: true, cyclesUsed: 0, skipped: true };
    }

    let failureCount = 0;
    let lastResult: EvaluatorResult | undefined;

    for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
      // Emit evaluator:invoked before each evaluation
      this.emitter.evaluatorInvoked(this.workflowId, this.phaseIndex, this.stepIndex);

      try {
        const result = await this.invokeWithTimeout(
          workerOutput,
          validationCriteria,
          contextFiles,
        );

        lastResult = result;

        if (result.passed) {
          // Success — emit completed and return
          this.emitter.evaluatorCompleted(this.workflowId, result);
          return {
            passed: true,
            cyclesUsed: cycle + 1,
            skipped: false,
          };
        }

        // Failure — counts against the cap
        failureCount++;
        if (failureCount >= MAX_CYCLES) {
          break;
        }

        // Will loop for another cycle
      } catch (error) {
        const err = error as Error;

        if (this.isTimeoutError(err)) {
          // Timeout — emit failed and return as if passed (skip)
          this.emitter.evaluatorFailed(this.workflowId, "timeout");
          return {
            passed: true,
            cyclesUsed: cycle + 1,
            skipped: true,
            reason: "evaluation timed out",
          };
        }

        // Non-timeout error (schema parse error, etc.) — counts as failure
        this.emitter.evaluatorFailed(this.workflowId, err.message);
        failureCount++;
        if (failureCount >= MAX_CYCLES) {
          // Exhausted all cycles with errors
          return {
            passed: false,
            cyclesUsed: failureCount,
            skipped: false,
            reason: err.message,
          };
        }
      }
    }

    // Exhausted all cycles via passed: false results
    if (lastResult) {
      this.emitter.evaluatorCompleted(this.workflowId, lastResult);
    }

    return {
      passed: false,
      cyclesUsed: MAX_CYCLES,
      skipped: false,
      reason: lastResult?.reasoning,
    };
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async invokeWithTimeout(
    workerOutput: string,
    validationCriteria: string,
    contextFiles: string[],
  ): Promise<EvaluatorResult> {
    const input = {
      worker_output: workerOutput,
      validation_criteria: validationCriteria,
      context_files: contextFiles,
    };

    // Race transport call against timeout
    const transportPromise = this.transport.invoke(input);
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        const err = new Error("Evaluation timed out");
        err.name = "TimeoutError";
        reject(err);
      }, this.timeoutMs);
    });

    return Promise.race([transportPromise, timeoutPromise]);
  }

  private isTimeoutError(error: Error): boolean {
    return error.name === "TimeoutError" || error.message.includes("timed out");
  }
}

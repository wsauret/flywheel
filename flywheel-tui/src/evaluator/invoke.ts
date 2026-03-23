/**
 * Evaluator — checks worker output quality and can request re-prompts.
 *
 * Max evaluation cycles configurable via constructor, default 3.
 * Timeouts skip evaluation (proceed). Skippable via config flag.
 */

import type { EvaluatorTransport } from "./transport";
import type { EvaluatorResult } from "../schemas/evaluator";
import type { FlywheelEmitter } from "../events/event-bus";
import type { ValidationCriteria } from "../schemas/shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CYCLES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a `ValidationCriteria` object to a human-readable string for the
 * evaluator prompt.
 */
function serializeValidationCriteria(
  criteria: ValidationCriteria,
): string {
  const parts: string[] = [];
  if (criteria.acceptance_criteria.length > 0) {
    parts.push(
      "Acceptance criteria:",
      ...criteria.acceptance_criteria.map((c) => `- ${c}`),
    );
  }
  if (criteria.required_tests) {
    parts.push("Required: tests must pass");
  }
  if (criteria.custom_checks.length > 0) {
    parts.push("Custom checks:", ...criteria.custom_checks.map((c) => `- ${c}`));
  }
  if (criteria.required_outputs.length > 0) {
    parts.push(
      "Required outputs:",
      ...criteria.required_outputs.map((o) => `- ${o}`),
    );
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvaluatorOptions {
  transport: EvaluatorTransport;
  emitter: FlywheelEmitter;
  workflowId: string;
  skipEvaluation?: boolean;
  timeoutMs?: number;
  /** Max evaluation cycles. Defaults to DEFAULT_MAX_CYCLES (3). */
  maxCycles?: number;
  /** Phase/step indices for event emission. Defaults to 0. */
  phaseIndex?: number;
  stepIndex?: number;
}

export interface EvaluateOptions {
  workerOutput: string;
  validationCriteria: ValidationCriteria;
  contextFiles: string[];
  acceptanceCriteria?: string[];
  artifactsProduced?: string[];
  testsPassed?: boolean | null;
  durationSeconds?: number;
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
  private readonly maxCycles: number;
  private readonly phaseIndex: number;
  private readonly stepIndex: number;

  constructor(options: EvaluatorOptions) {
    this.transport = options.transport;
    this.emitter = options.emitter;
    this.workflowId = options.workflowId;
    this.skipEvaluation = options.skipEvaluation ?? false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxCycles = options.maxCycles ?? DEFAULT_MAX_CYCLES;
    this.phaseIndex = options.phaseIndex ?? 0;
    this.stepIndex = options.stepIndex ?? 0;
  }

  /**
   * Evaluate worker output. Max evaluation cycles configurable via constructor, default 3.
   * Timeouts don't count against the cycle cap.
   *
   * `validationCriteria` accepts both a plain string and a structured
   * `ValidationCriteria` object (from DispatcherDecision). Objects are
   * serialized to a string before being passed to the evaluator transport.
   *
   * Additional optional fields (`acceptanceCriteria`, `artifactsProduced`,
   * `testsPassed`, `durationSeconds`) are forwarded to the evaluator input
   * when provided. If `validationCriteria` is a structured object, its
   * `acceptance_criteria` are merged with the explicit `acceptanceCriteria`.
   */
  async evaluate(options: EvaluateOptions): Promise<EvaluationResult> {
    // Skip evaluation if configured
    if (this.skipEvaluation) {
      return { passed: true, cyclesUsed: 0, skipped: true };
    }

    const {
      workerOutput,
      validationCriteria,
      contextFiles,
      artifactsProduced,
      testsPassed,
      durationSeconds,
    } = options;

    // Serialize structured ValidationCriteria to string for the evaluator transport
    const criteriaString = serializeValidationCriteria(validationCriteria);

    // Merge acceptance_criteria: explicit + extracted from structured criteria
    const extractedCriteria = validationCriteria.acceptance_criteria;
    const explicitCriteria = options.acceptanceCriteria ?? [];
    const mergedCriteria = [...new Set([...explicitCriteria, ...extractedCriteria])];

    let failureCount = 0;
    let lastResult: EvaluatorResult | undefined;

    for (let cycle = 0; cycle < this.maxCycles; cycle++) {
      // Emit evaluator:invoked before each evaluation
      this.emitter.evaluatorInvoked(this.workflowId, this.phaseIndex, this.stepIndex);

      try {
        const result = await this.invokeWithTimeout(
          workerOutput,
          criteriaString,
          contextFiles,
          mergedCriteria,
          artifactsProduced ?? [],
          testsPassed ?? null,
          durationSeconds ?? 0,
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
        if (failureCount >= this.maxCycles) {
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
        if (failureCount >= this.maxCycles) {
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
      cyclesUsed: this.maxCycles,
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
    acceptanceCriteria: string[],
    artifactsProduced: string[],
    testsPassed: boolean | null,
    durationSeconds: number,
  ): Promise<EvaluatorResult> {
    const input: import("../schemas/evaluator").EvaluatorInput = {
      worker_output: workerOutput,
      validation_criteria: validationCriteria,
      context_files: contextFiles,
      acceptance_criteria: acceptanceCriteria,
      artifacts_produced: artifactsProduced,
      tests_passed: testsPassed,
      duration_seconds: durationSeconds,
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

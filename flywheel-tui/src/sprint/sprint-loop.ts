/**
 * Sprint Execution Loop — the core iterate-verify-escalate cycle.
 *
 * 1. Spawn worker via PhaseExecutor
 * 2. Read handoff, extract verification_script_path
 * 3. Run verification script via VerificationRunner
 * 4. Pass worker handoff + verification result to evaluator with adversarial sprint prompt
 * 5. If evaluator passes → return success
 * 6. If evaluator fails → accumulate context, retry
 * 7. On hard cap → escalate with full iteration history
 *
 * Handles: single-iteration success, cumulative context across retries,
 * hard cap enforcement (including cap=1), worker crash (count as failed
 * iteration), missing worker artifacts (count as failed, include specific
 * feedback), verification script failure (pass to evaluator, not loop error),
 * evaluator transport failure (degrade to script exit code), skip_evaluation
 * config (skip evaluator, use script exit code), shutdown request (stop
 * cleanly), budget exhaustion (stop with budget_exhausted).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { FlywheelEmitter } from "../events/event-bus";
import type { FlywheelConfig } from "../config/loader";
import type { PhaseExecutor } from "../controller/phase-executor";
import { WorkerError } from "../controller/phase-executor";
import type { EvaluatorTransport } from "../evaluator/transport";
import type { BudgetTracker } from "../session/budget-tracker";
import type { BudgetLimits } from "../schemas/shared";
import type { IWorkflowUI } from "../tui/adapters/types";
import { readHandoff, HandoffMissingError, HandoffInvalidError } from "../handoff/reader";
import { WorkerHandoffSchema } from "../schemas/handoff";
import type { WorkerHandoff } from "../schemas/handoff";
import {
  runVerificationScript,
  type VerificationResult,
} from "./verification-runner";
import { buildSprintPhasePrompt } from "../prompts/sprint/phase-prompt";
import {
  buildSprintRevisionPrompt,
  type SprintIterationSummary,
} from "../prompts/sprint/revision-prompt";
import {
  buildSprintEvaluatorPrompt,
  SPRINT_EVALUATOR_SYSTEM_PROMPT,
  type SprintEvaluatorInput,
} from "../prompts/sprint/evaluator-prompt";
import { HANDOFFS_DIR } from "../config/paths";
import { Log } from "../utils/log";

const log = Log.create({ service: "sprint-loop" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Injectable function to read a worker handoff file.
 * Default: uses readHandoff from handoff/reader.
 */
export type HandoffReader = (handoffPath: string) => Promise<WorkerHandoff>;

/**
 * Injectable function to run a verification script.
 * Default: uses runVerificationScript from verification-runner.
 */
export type VerificationScriptRunner = (
  scriptPath: string,
  options: { projectCwd: string; timeoutMs: number },
) => Promise<VerificationResult>;

export interface SprintLoopOptions {
  /** Task description for the sprint. */
  taskDescription: string;
  /** Core dependencies. */
  config: FlywheelConfig;
  executor: PhaseExecutor;
  emitter: FlywheelEmitter;
  ui: IWorkflowUI;
  workflowId: string;
  /** Optional capabilities. */
  evaluatorTransport?: EvaluatorTransport;
  budgetTracker?: BudgetTracker;
  budgetLimits?: BudgetLimits;
  /** Base directory for subprocess JSONL logging. */
  logBaseDir?: string;
  /** DI: override handoff reader (for testing). */
  _readHandoff?: HandoffReader;
  /** DI: override verification runner (for testing). */
  _runVerification?: VerificationScriptRunner;
}

export interface SprintLoopResult {
  /** Whether the sprint completed successfully (evaluator or script passed). */
  completed: boolean;
  /** Number of iterations actually used. */
  iterationsUsed: number;
  /** Whether the sprint was escalated (hard cap reached). */
  escalated: boolean;
  /** Full iteration history for escalation carry-forward. */
  iterationHistory: SprintIterationRecord[];
  /** Stop reason when not completed. */
  reason?: string;
}

export interface SprintIterationRecord {
  iteration: number;
  workerSummary: string;
  verificationResult?: VerificationResult;
  evaluatorPassed?: boolean;
  evaluatorFeedback?: {
    implementation: string;
    script: string;
  };
  scriptContent?: string;
  workerCrashed?: boolean;
  missingArtifact?: string;
}

export interface SprintLoopHandle {
  /** Run the sprint loop. */
  run(): Promise<SprintLoopResult>;
  /** Request graceful shutdown. */
  requestShutdown(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSprintLoop(options: SprintLoopOptions): SprintLoopHandle {
  const {
    taskDescription,
    config,
    executor,
    emitter,
    workflowId,
    evaluatorTransport,
    budgetTracker,
    budgetLimits,
    logBaseDir,
    _readHandoff: readHandoffOverride,
    _runVerification: runVerificationOverride,
  } = options;

  // DI: use overrides or default implementations
  const doReadHandoff: HandoffReader = readHandoffOverride ??
    ((hp: string) => readHandoff(hp, WorkerHandoffSchema));
  const doRunVerification: VerificationScriptRunner = runVerificationOverride ??
    runVerificationScript;

  const sprintConfig = config.sprint;
  const maxIterations = sprintConfig.max_iterations;
  const projectCwd = config.project_cwd || process.cwd();

  let shutdownRequested = false;
  const shutdownController = new AbortController();

  function requestShutdown(): void {
    shutdownRequested = true;
    shutdownController.abort();
  }

  async function run(): Promise<SprintLoopResult> {
    const iterationHistory: SprintIterationRecord[] = [];
    const previousScripts: string[] = [];
    let iterationsUsed = 0;

    // Emit sprint started
    emitter.sprintStarted(workflowId, taskDescription, maxIterations);
    log.info("sprint loop started", { workflowId, maxIterations, taskDescription: taskDescription.slice(0, 100) });

    // Resolve handoffs directory
    const handoffsDir = path.resolve(projectCwd, HANDOFFS_DIR);
    fs.mkdirSync(handoffsDir, { recursive: true });

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      // --- Check shutdown before starting new iteration ---
      if (shutdownRequested) {
        const result: SprintLoopResult = {
          completed: false,
          iterationsUsed,
          escalated: false,
          iterationHistory,
          reason: "Shutdown requested",
        };
        emitter.sprintCompleted(workflowId, false, iterationsUsed, false, "Shutdown requested");
        return result;
      }

      // --- Check budget before starting new iteration ---
      if (budgetTracker && budgetLimits && budgetTracker.isExhausted(budgetLimits)) {
        const result: SprintLoopResult = {
          completed: false,
          iterationsUsed,
          escalated: false,
          iterationHistory,
          reason: "budget_exhausted",
        };
        emitter.sprintCompleted(workflowId, false, iterationsUsed, false, "budget_exhausted");
        return result;
      }

      emitter.sprintIterationStarted(workflowId, iteration, maxIterations);
      log.info("sprint iteration started", { iteration, maxIterations });

      // Build iteration record to track this attempt
      const record: SprintIterationRecord = {
        iteration,
        workerSummary: "",
      };

      // --- Step 1: Spawn worker ---
      const invocationId = crypto.randomUUID();
      const handoffPath = path.resolve(handoffsDir, `${invocationId}.json`);

      // Build prompt
      const prompt = buildPromptForIteration(
        iteration,
        maxIterations,
        taskDescription,
        iterationHistory,
        handoffPath,
        projectCwd,
      );

      let workerHandoff: WorkerHandoff | undefined;
      let workerCrashed = false;

      try {
        const workerResult = await executor.execute({
          phaseIndex: 0,
          prompt,
          cwd: projectCwd,
          onStdout: (chunk) => emitter.workerOutput(workflowId, "stdout", chunk, config.engine),
          onStderr: (chunk) => emitter.workerOutput(workflowId, "stderr", chunk, config.engine),
          signal: shutdownController.signal,
          invocationId,
          logBaseDir,
        });

        // Increment invocation count
        budgetTracker?.incrementInvocations();

        // Read worker handoff
        try {
          workerHandoff = await doReadHandoff(workerResult.handoffPath);
          record.workerSummary = workerHandoff.summary;
        } catch (err) {
          if (err instanceof HandoffMissingError) {
            log.warn("sprint worker handoff missing", { iteration });
            record.workerSummary = "Worker did not produce handoff file";
            record.missingArtifact = "no handoff JSON written";
          } else if (err instanceof HandoffInvalidError) {
            log.warn("sprint worker handoff invalid", { iteration, error: err.message });
            record.workerSummary = `Worker handoff invalid: ${err.message}`;
            record.missingArtifact = "handoff JSON invalid";
          } else {
            log.warn("unexpected error reading sprint worker handoff", { iteration, error: String(err) });
            record.workerSummary = "Failed to read worker handoff";
            record.missingArtifact = "handoff read failed";
          }
        }
      } catch (error) {
        // Worker crashed — count as failed iteration
        workerCrashed = true;
        const reason = error instanceof WorkerError
          ? error.result.failure?.message ?? error.message
          : error instanceof Error ? error.message : String(error);
        log.warn("sprint worker crashed", { iteration, reason });
        record.workerSummary = `Worker crashed: ${reason}`;
        record.workerCrashed = true;
      }

      // --- Step 2: Check for needs_plan escalation (if enabled) ---
      if (
        !workerCrashed &&
        workerHandoff &&
        sprintConfig.worker_can_escalate &&
        (workerHandoff as Record<string, unknown>).needs_plan === true
      ) {
        log.info("worker signaled needs_plan, escalating", { iteration });
        record.workerSummary += " [needs_plan escalation]";
        iterationHistory.push(record);
        iterationsUsed = iteration;

        emitter.sprintEscalated(workflowId, iterationsUsed, "Worker signaled needs_plan");
        emitter.sprintCompleted(workflowId, false, iterationsUsed, true, "Worker signaled needs_plan");
        return {
          completed: false,
          iterationsUsed,
          escalated: true,
          iterationHistory,
          reason: "Worker signaled needs_plan",
        };
      }

      // --- Step 3: Handle missing artifacts / worker crash ---
      if (workerCrashed || record.missingArtifact) {
        iterationHistory.push(record);
        iterationsUsed = iteration;

        const feedback = workerCrashed
          ? `Iteration ${iteration} failed: worker crashed`
          : `Iteration ${iteration} failed: ${record.missingArtifact}`;

        emitter.sprintIterationCompleted(workflowId, iteration, false, feedback);

        // If at hard cap, escalate
        if (iteration >= maxIterations) {
          return handleHardCap(iterationsUsed, iterationHistory);
        }
        continue;
      }

      // --- Step 4: Run verification script ---
      const scriptPath = workerHandoff?.verification_script_path;
      let verificationResult: VerificationResult;

      if (!scriptPath) {
        // Missing verification_script_path — failed iteration
        log.warn("sprint worker did not provide verification_script_path", { iteration });
        record.missingArtifact = "verification_script_path not provided";
        iterationHistory.push(record);
        iterationsUsed = iteration;

        emitter.sprintIterationCompleted(
          workflowId, iteration, false,
          "Worker did not provide verification_script_path in handoff",
        );

        if (iteration >= maxIterations) {
          return handleHardCap(iterationsUsed, iterationHistory);
        }
        continue;
      }

      emitter.sprintVerificationStarted(workflowId, iteration, scriptPath);

      verificationResult = await doRunVerification(scriptPath, {
        projectCwd,
        timeoutMs: sprintConfig.verification_timeout_ms,
      });

      record.verificationResult = verificationResult;

      // Read script content for evaluator
      let scriptContent = "";
      try {
        const resolvedScriptPath = path.resolve(projectCwd, scriptPath);
        if (fs.existsSync(resolvedScriptPath)) {
          scriptContent = fs.readFileSync(resolvedScriptPath, "utf-8");
        }
      } catch {
        // Best-effort script reading
      }
      record.scriptContent = scriptContent;

      // --- Step 5: Evaluate (or use script exit code) ---
      let iterationPassed = false;

      if (
        evaluatorTransport &&
        !config.skip_evaluation
      ) {
        // Invoke evaluator with adversarial sprint prompt
        try {
          const evalInput: SprintEvaluatorInput = {
            taskDescription,
            iterationNumber: iteration,
            maxIterations,
            workerHandoff: {
              summary: workerHandoff?.summary ?? "",
              artifacts: workerHandoff?.artifacts,
              verification: workerHandoff?.verification,
              verification_script_path: workerHandoff?.verification_script_path,
            },
            verificationResult: {
              stdout: verificationResult.stdout,
              stderr: verificationResult.stderr,
              exitCode: verificationResult.exitCode ?? -1,
              passed: verificationResult.passed,
            },
            currentScriptContent: scriptContent,
            previousScripts: previousScripts.length > 0 ? previousScripts : undefined,
            handoffPath: path.resolve(handoffsDir, `eval-${invocationId}.json`),
          };

          const evalPrompt = buildSprintEvaluatorPrompt(evalInput);

          // Use evaluator transport directly
          emitter.evaluatorInvoked(workflowId, 0, 0);

          const evalResult = await evaluatorTransport.invoke({
            worker_output: workerHandoff?.summary ?? "",
            validation_criteria: evalPrompt,
            context_files: [],
            acceptance_criteria: [],
            artifacts_produced: [
              ...(workerHandoff?.artifacts?.files_created ?? []),
              ...(workerHandoff?.artifacts?.files_modified ?? []),
            ],
            tests_passed: workerHandoff?.verification?.tests_passed ?? null,
            duration_seconds: 0,
            task_context: taskDescription,
          });

          emitter.evaluatorCompleted(workflowId, evalResult);

          iterationPassed = evalResult.passed;
          record.evaluatorPassed = evalResult.passed;

          if (!evalResult.passed) {
            // Extract dual-channel feedback
            record.evaluatorFeedback = {
              implementation: (evalResult as Record<string, unknown>).implementation_feedback as string ?? evalResult.feedback ?? evalResult.reasoning ?? "",
              script: (evalResult as Record<string, unknown>).script_feedback as string ?? "",
            };
          }
        } catch (error) {
          // Evaluator transport failure — degrade to script exit code
          const errMsg = error instanceof Error ? error.message : String(error);
          log.warn("sprint evaluator transport failed, degrading to script exit code", {
            iteration,
            error: errMsg,
          });
          emitter.evaluatorFailed(workflowId, errMsg);
          iterationPassed = verificationResult.passed;
          record.evaluatorPassed = undefined; // No evaluator verdict
        }
      } else {
        // No evaluator or skip_evaluation — use script exit code
        iterationPassed = verificationResult.passed;
      }

      // Track script for weakening detection
      if (scriptContent) {
        previousScripts.push(scriptContent);
      }

      iterationHistory.push(record);
      iterationsUsed = iteration;

      // --- Step 6: Emit iteration result ---
      emitter.sprintIterationCompleted(
        workflowId,
        iteration,
        iterationPassed,
        iterationPassed ? undefined : (record.evaluatorFeedback?.implementation ?? "Verification or evaluation failed"),
      );

      // --- Step 7: Check pass/fail ---
      if (iterationPassed) {
        // Success!
        log.info("sprint iteration passed", { iteration });
        emitter.sprintCompleted(workflowId, true, iterationsUsed, false);
        return {
          completed: true,
          iterationsUsed,
          escalated: false,
          iterationHistory,
        };
      }

      // --- Step 8: Check stuck detection (if enabled) ---
      if (sprintConfig.escalate_on_stuck && iterationHistory.length >= 2) {
        const lastTwo = iterationHistory.slice(-2);
        if (isStuck(lastTwo)) {
          log.info("sprint stuck detected, escalating", { iteration });
          emitter.sprintEscalated(workflowId, iterationsUsed, "Stuck: identical verification failures");
          emitter.sprintCompleted(workflowId, false, iterationsUsed, true, "Stuck: identical verification failures");
          return {
            completed: false,
            iterationsUsed,
            escalated: true,
            iterationHistory,
            reason: "Stuck: identical verification failures",
          };
        }
      }

      // --- Step 9: If at hard cap, escalate ---
      if (iteration >= maxIterations) {
        return handleHardCap(iterationsUsed, iterationHistory);
      }

      // Otherwise continue to next iteration
      log.info("sprint iteration failed, retrying", { iteration, maxIterations });
    }

    // Should not reach here, but safety net
    emitter.sprintCompleted(workflowId, false, iterationsUsed, true, "Max iterations reached");
    return {
      completed: false,
      iterationsUsed,
      escalated: true,
      iterationHistory,
      reason: "Max iterations reached",
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function handleHardCap(
    iterationsUsed: number,
    iterationHistory: SprintIterationRecord[],
  ): SprintLoopResult {
    log.info("sprint hard cap reached, escalating", { iterationsUsed, maxIterations });
    emitter.sprintEscalated(workflowId, iterationsUsed, "Max iterations reached");
    emitter.sprintCompleted(workflowId, false, iterationsUsed, true, "Max iterations reached");
    return {
      completed: false,
      iterationsUsed,
      escalated: true,
      iterationHistory,
      reason: "Max iterations reached",
    };
  }

  return {
    run,
    requestShutdown,
  };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildPromptForIteration(
  iteration: number,
  maxIterations: number,
  taskDescription: string,
  previousIterations: SprintIterationRecord[],
  handoffPath: string,
  projectCwd: string,
): string {
  if (iteration === 1) {
    return buildSprintPhasePrompt({
      planContent: taskDescription,
      keyDecisions: [],
      fileReferences: [],
      projectCwd,
      extra: { handoffPath },
    });
  }

  // Convert iteration records to revision input format
  const summaries: SprintIterationSummary[] = previousIterations.map((r) => ({
    iteration: r.iteration,
    workerSummary: r.workerSummary,
    evaluatorFeedback: r.evaluatorFeedback,
    verificationOutput: r.verificationResult
      ? {
          stdout: r.verificationResult.stdout,
          stderr: r.verificationResult.stderr,
          exitCode: r.verificationResult.exitCode ?? -1,
        }
      : undefined,
    scriptContent: r.scriptContent,
  }));

  return buildSprintRevisionPrompt({
    ctx: {
      planContent: taskDescription,
      keyDecisions: [],
      fileReferences: [],
      projectCwd,
      extra: { handoffPath },
    },
    currentIteration: iteration,
    maxIterations,
    previousIterations: summaries,
  });
}

/**
 * Detect if the sprint is stuck — identical verification failures across
 * the last two consecutive iterations.
 */
function isStuck(lastTwo: SprintIterationRecord[]): boolean {
  if (lastTwo.length < 2) return false;

  const [prev, curr] = lastTwo;

  // Both must have verification results that failed
  if (!prev.verificationResult || !curr.verificationResult) return false;
  if (prev.verificationResult.passed || curr.verificationResult.passed) return false;

  // Compare stdout+stderr+exitCode
  return (
    prev.verificationResult.stdout === curr.verificationResult.stdout &&
    prev.verificationResult.stderr === curr.verificationResult.stderr &&
    prev.verificationResult.exitCode === curr.verificationResult.exitCode
  );
}

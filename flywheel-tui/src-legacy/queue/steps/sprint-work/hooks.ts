// ---------------------------------------------------------------------------
// Sprint Queue Handler — reimplements sprint mode as queue steps
// ---------------------------------------------------------------------------
//
// Sprint creates an initial [work, verify] queue. The work step uses
// sprint-specific prompts. The verify step runs a verification script.
// On verify failure, new work+verify pairs are inserted. On max iterations,
// escalation steps [plan, work, review] are inserted.
//
// Terminology:
//   Step   — single unit of work
//   Queue  — mutable, ordered list of steps
// ---------------------------------------------------------------------------

import { randomUUID } from "crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { Step, Queue } from "../../types";
import { insertAfter, type Provenance } from "../../queue";
import type { OnStepCompletedResult } from "../../shared/hooks";
import type { FlywheelEmitter } from "../../../events/event-bus";
import type { VerificationResult } from "./verification-runner";
import {
  buildSprintStepPrompt,
} from "./step-prompt";
import {
  buildSprintRevisionPrompt,
  type SprintIterationSummary,
} from "./revision-prompt";
import {
  buildEscalationContext,
  type EscalationContext,
} from "./escalation-context";
import type { SprintIterationRecord, SprintLoopResult } from "./sprint-types";
import { Log } from "../../../utils/log";

const log = Log.create({ service: "sprint-queue" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Injectable function to run a verification script.
 * Default: uses runVerificationScript from verification-runner.
 */
export type VerificationScriptRunner = (
  scriptPath: string,
  options: { projectCwd: string; timeoutMs: number },
) => Promise<VerificationResult>;

/**
 * Injectable function to read a handoff file and return parsed JSON.
 */
export type HandoffReaderFn = (
  handoffPath: string,
) => Promise<Record<string, unknown> | null>;

export interface SprintQueueOptions {
  /** Task description for the sprint. */
  taskDescription: string;
  /** Project working directory. */
  projectCwd: string;
  /** Sprint configuration. */
  sprintConfig: {
    max_iterations: number;
    verification_timeout_ms: number;
    escalate_to_full: boolean;
    escalate_on_stuck: boolean;
  };
  /** Event emitter. */
  emitter: FlywheelEmitter;
  /** Workflow ID for event emission. */
  workflowId: string;
  /** DI: verification script runner. */
  runVerification: VerificationScriptRunner;
  /** DI: handoff reader. */
  readHandoff: HandoffReaderFn;
}

export interface SprintQueueState {
  /** Current iteration number (1-based). */
  iterationCount: number;
  /** Full iteration history. */
  iterationHistory: SprintIterationRecord[];
  /** Whether escalation was triggered. */
  escalated: boolean;
  /** Whether sprint completed successfully. */
  completed: boolean;
  /** Escalation context (if escalated). */
  escalationContext?: EscalationContext;
}

export interface SprintQueueHandler {
  /** Hook to pass to StepExecutorOptions.onStepCompleted. */
  onStepCompleted: (
    step: Step,
    status: "completed" | "failed",
    queue: Queue,
    handoffData: Record<string, unknown> | null,
  ) => Promise<OnStepCompletedResult>;
  /** Get current sprint state. */
  getState(): SprintQueueState;
  /** Build prompt for a sprint work step (first or revision). */
  buildWorkStepPrompt(step: Step): string;
  /**
   * Execute a verify step: read handoff from preceding work step,
   * extract verification_script_path, run the script.
   * Returns the verification result.
   */
  executeVerifyStep(
    step: Step,
    handoffData: Record<string, unknown> | null,
  ): Promise<VerificationResult>;
}

// ---------------------------------------------------------------------------
// Step factory helpers
// ---------------------------------------------------------------------------

function makeWorkStep(title: string): Step {
  return { id: randomUUID(), type: "work", title, status: "pending" };
}

function makeVerifyStep(title: string): Step {
  return { id: randomUUID(), type: "verify", title, status: "pending" };
}

function makePlanStep(title: string): Step {
  return { id: randomUUID(), type: "plan", title, status: "pending" };
}

function makeReviewStep(title: string): Step {
  return { id: randomUUID(), type: "review", title, status: "pending" };
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

const SPRINT_PROVENANCE: Provenance = {
  actor: "sprint-handler",
  reason: "sprint iteration management",
};

function makeProvenance(reason: string): Provenance {
  return { actor: "sprint-handler", reason };
}

// ---------------------------------------------------------------------------
// Stuck detection
// ---------------------------------------------------------------------------

/**
 * Detect if the sprint is stuck — identical verification failures across
 * the last two consecutive iterations.
 */
function isStuck(history: SprintIterationRecord[]): boolean {
  if (history.length < 2) return false;

  const prev = history[history.length - 2];
  const curr = history[history.length - 1];

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

// ---------------------------------------------------------------------------
// createSprintQueueHandler — factory function
// ---------------------------------------------------------------------------

export function createSprintQueueHandler(
  options: SprintQueueOptions,
): SprintQueueHandler {
  const {
    taskDescription,
    projectCwd,
    sprintConfig,
    emitter,
    workflowId,
    runVerification,
    readHandoff,
  } = options;

  const maxIterations = sprintConfig.max_iterations;

  // Sprint state
  let iterationCount = 0;
  const iterationHistory: SprintIterationRecord[] = [];
  let escalated = false;
  let completed = false;
  /** Handoff from the most recent work step, used by verify steps. */
  let lastWorkHandoff: Record<string, unknown> | null = null;

  // -------------------------------------------------------------------------
  // getState
  // -------------------------------------------------------------------------

  function getState(): SprintQueueState {
    return {
      iterationCount,
      iterationHistory: [...iterationHistory],
      escalated,
      completed,
      escalationContext: escalated
        ? buildEscalationContext({
            completed: false,
            iterationsUsed: iterationCount,
            escalated: true,
            iterationHistory,
            reason: "Max iterations reached",
          })
        : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // buildWorkStepPrompt — sprint-specific prompt for work steps
  // -------------------------------------------------------------------------

  function buildWorkStepPrompt(_step: Step): string {
    const iteration = iterationCount + 1; // Next iteration

    if (iteration === 1 || iterationHistory.length === 0) {
      // First iteration: use buildSprintStepPrompt
      return buildSprintStepPrompt({
        planContent: taskDescription,
        keyDecisions: [],
        fileReferences: [],
        projectCwd,
      });
    }

    // Revision iteration: use buildSprintRevisionPrompt
    const summaries: SprintIterationSummary[] = iterationHistory.map((r) => ({
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
      },
      currentIteration: iteration,
      maxIterations,
      previousIterations: summaries,
    });
  }

  // -------------------------------------------------------------------------
  // executeVerifyStep — run the verification script
  // -------------------------------------------------------------------------

  async function executeVerifyStep(
    _step: Step,
    handoffData: Record<string, unknown> | null,
  ): Promise<VerificationResult> {
    // Use the handoff from the preceding work step
    const handoff = handoffData ?? lastWorkHandoff;

    if (!handoff) {
      log.warn("verify step: no handoff available");
      return {
        passed: false,
        stdout: "",
        stderr: "",
        error: "No handoff available from preceding work step",
        durationMs: 0,
      };
    }

    const scriptPath = handoff.verification_script_path as string | undefined;
    if (!scriptPath) {
      log.warn("verify step: no verification_script_path in handoff");
      return {
        passed: false,
        stdout: "",
        stderr: "",
        error: "No verification_script_path in handoff",
        durationMs: 0,
      };
    }

    return runVerification(scriptPath, {
      projectCwd,
      timeoutMs: sprintConfig.verification_timeout_ms,
    });
  }

  // -------------------------------------------------------------------------
  // insertRetryPair — insert work+verify after a step
  // -------------------------------------------------------------------------

  function insertRetryPair(
    queue: Queue,
    afterStepId: string,
    iteration: number,
  ): void {
    const workStep = makeWorkStep(`Sprint work (iteration ${iteration})`);
    const verifyStep = makeVerifyStep(`Verify changes (iteration ${iteration})`);

    const result = insertAfter(queue, afterStepId, [workStep, verifyStep],
      makeProvenance(`Sprint retry: inserting work+verify pair for iteration ${iteration}`));

    if (result.success) {
      emitter.queueStepInserted(workflowId, workStep.id, workStep.type, workStep.title, afterStepId);
      emitter.queueStepInserted(workflowId, verifyStep.id, verifyStep.type, verifyStep.title, workStep.id);
      log.info("sprint retry pair inserted", { iteration, afterStepId });
    } else {
      log.warn("failed to insert sprint retry pair", {
        iteration,
        error: "error" in result ? result.error : "unknown",
      });
    }
  }

  // -------------------------------------------------------------------------
  // insertEscalationSteps — insert [plan, work, review] for escalation
  // -------------------------------------------------------------------------

  function insertEscalationSteps(
    queue: Queue,
    afterStepId: string,
  ): void {
    const planStep = makePlanStep("Escalation: create new plan");
    const workStep = makeWorkStep("Escalation: implement plan");
    const reviewStep = makeReviewStep("Escalation: review changes");

    const result = insertAfter(queue, afterStepId,
      [planStep, workStep, reviewStep],
      makeProvenance(`Sprint escalation: max iterations (${maxIterations}) reached`));

    if (result.success) {
      emitter.queueStepInserted(workflowId, planStep.id, planStep.type, planStep.title, afterStepId);
      emitter.queueStepInserted(workflowId, workStep.id, workStep.type, workStep.title, planStep.id);
      emitter.queueStepInserted(workflowId, reviewStep.id, reviewStep.type, reviewStep.title, workStep.id);
      log.info("sprint escalation steps inserted", { afterStepId });
    } else {
      log.warn("failed to insert escalation steps", {
        error: "error" in result ? result.error : "unknown",
      });
    }
  }

  // -------------------------------------------------------------------------
  // onStepCompleted — the hook for the step executor
  // -------------------------------------------------------------------------

  async function onStepCompleted(
    step: Step,
    status: "completed" | "failed",
    queue: Queue,
    handoffData: Record<string, unknown> | null,
  ): Promise<OnStepCompletedResult> {
    // After escalation, inserted steps (plan/work/review) should not be
    // processed by sprint iteration logic — just let the executor run them.
    if (escalated) {
      return { continueExecution: false };
    }

    // --- Handle work step completion ---
    if (step.type === "work") {
      return handleWorkStepCompleted(step, status, queue, handoffData);
    }

    // --- Handle verify step completion ---
    if (step.type === "verify") {
      return handleVerifyStepCompleted(step, status, queue, handoffData);
    }

    // For non-sprint step types (escalation plan/review), use default behavior
    return { continueExecution: false };
  }

  // -------------------------------------------------------------------------
  // handleWorkStepCompleted
  // -------------------------------------------------------------------------

  function handleWorkStepCompleted(
    step: Step,
    status: "completed" | "failed",
    queue: Queue,
    handoffData: Record<string, unknown> | null,
  ): Promise<OnStepCompletedResult> {
    if (status === "completed") {
      // Store handoff for the verify step
      lastWorkHandoff = handoffData;
      return Promise.resolve({ continueExecution: false });
    }

    // Work step failed (worker crash) — count as failed iteration
    iterationCount++;
    const record: SprintIterationRecord = {
      iteration: iterationCount,
      workerSummary: "Worker crashed",
      workerCrashed: true,
    };
    iterationHistory.push(record);

    log.warn("sprint work step failed (worker crash)", {
      iteration: iterationCount,
      stepId: step.id,
    });

    // Find the verify step that follows this work step and skip it
    const stepIdx = queue.steps.findIndex((s) => s.id === step.id);
    const nextStep = stepIdx >= 0 && stepIdx + 1 < queue.steps.length
      ? queue.steps[stepIdx + 1]
      : null;

    // Skip the verify step since work failed
    if (nextStep && nextStep.type === "verify" && nextStep.status === "pending") {
      nextStep.status = "skipped";
    }

    const afterId = nextStep ? nextStep.id : step.id;

    // Check if max iterations reached
    if (iterationCount >= maxIterations) {
      if (sprintConfig.escalate_to_full) {
        escalated = true;
        insertEscalationSteps(queue, afterId);
        return Promise.resolve({ continueExecution: true });
      }
      return Promise.resolve({ continueExecution: false });
    }

    // Insert retry pair
    insertRetryPair(queue, afterId, iterationCount + 1);
    return Promise.resolve({ continueExecution: true });
  }

  // -------------------------------------------------------------------------
  // handleVerifyStepCompleted
  // -------------------------------------------------------------------------

  async function handleVerifyStepCompleted(
    step: Step,
    status: "completed" | "failed",
    queue: Queue,
    handoffData: Record<string, unknown> | null,
  ): Promise<OnStepCompletedResult> {
    iterationCount++;

    if (status === "completed") {
      // Verify passed — sprint succeeded!
      // Extract verification result from handoff if available
      const verifyResult = handoffData?.verificationResult as VerificationResult | undefined;

      if (verifyResult && verifyResult.passed) {
        completed = true;
        const record: SprintIterationRecord = {
          iteration: iterationCount,
          workerSummary: lastWorkHandoff?.summary as string ?? "Work completed",
          verificationResult: verifyResult,
        };
        iterationHistory.push(record);
        log.info("sprint verify passed", { iteration: iterationCount });
        return { continueExecution: false };
      }

      // Verify step completed but result shows failure (the step itself completed
      // because it ran successfully, but the verification script returned non-zero)
      if (verifyResult && !verifyResult.passed) {
        return handleVerifyFailure(step, queue, verifyResult);
      }

      // Completed without verification result data — treat as success
      completed = true;
      const record: SprintIterationRecord = {
        iteration: iterationCount,
        workerSummary: lastWorkHandoff?.summary as string ?? "Work completed",
      };
      iterationHistory.push(record);
      return { continueExecution: false };
    }

    // Verify step failed (e.g., verification script error, missing handoff)
    // Treat as a failed iteration
    const handoff = lastWorkHandoff;
    const scriptPath = handoff?.verification_script_path as string | undefined;

    // Try to get verification result from the step's failure data
    let verifyResult: VerificationResult | undefined;
    if (handoffData?.verificationResult) {
      verifyResult = handoffData.verificationResult as VerificationResult;
    }

    return handleVerifyFailure(step, queue, verifyResult ?? {
      passed: false,
      stdout: "",
      stderr: "",
      error: "Verify step failed",
      durationMs: 0,
    });
  }

  // -------------------------------------------------------------------------
  // handleVerifyFailure — common logic for verify failure
  // -------------------------------------------------------------------------

  async function handleVerifyFailure(
    step: Step,
    queue: Queue,
    verifyResult: VerificationResult,
  ): Promise<OnStepCompletedResult> {
    // Read script content for history
    let scriptContent = "";
    const handoff = lastWorkHandoff;
    const scriptPath = handoff?.verification_script_path as string | undefined;
    if (scriptPath) {
      try {
        const resolvedPath = path.resolve(projectCwd, scriptPath);
        if (fs.existsSync(resolvedPath)) {
          scriptContent = fs.readFileSync(resolvedPath, "utf-8");
        }
      } catch {
        // Best-effort script reading
      }
    }

    const record: SprintIterationRecord = {
      iteration: iterationCount,
      workerSummary: handoff?.summary as string ?? "Work completed",
      verificationResult: verifyResult,
      scriptContent,
      missingArtifact: !scriptPath ? "verification_script_path not provided" : undefined,
    };
    iterationHistory.push(record);

    log.info("sprint verify failed", {
      iteration: iterationCount,
      timedOut: verifyResult.timedOut,
      exitCode: verifyResult.exitCode,
    });

    // Check stuck detection
    if (sprintConfig.escalate_on_stuck && isStuck(iterationHistory)) {
      log.info("sprint stuck detected, escalating", { iteration: iterationCount });
      escalated = true;
      if (sprintConfig.escalate_to_full) {
        insertEscalationSteps(queue, step.id);
      }
      return { continueExecution: sprintConfig.escalate_to_full };
    }

    // Check max iterations
    if (iterationCount >= maxIterations) {
      log.info("sprint max iterations reached", {
        iteration: iterationCount,
        maxIterations,
      });
      escalated = true;
      if (sprintConfig.escalate_to_full) {
        insertEscalationSteps(queue, step.id);
        return { continueExecution: true };
      }
      return { continueExecution: false };
    }

    // Insert retry pair
    insertRetryPair(queue, step.id, iterationCount + 1);
    return { continueExecution: true };
  }

  // -------------------------------------------------------------------------
  // Return the handler
  // -------------------------------------------------------------------------

  return {
    onStepCompleted,
    getState,
    buildWorkStepPrompt,
    executeVerifyStep,
  };
}

// ---------------------------------------------------------------------------
// Debug Queue Handler — iterative fix-verify loop with hypothesis tracking
// ---------------------------------------------------------------------------
//
// Debug creates an initial [investigate, fix, verify] queue. When verification
// fails, new fix+verify pairs are inserted after the failing verify step.
// Tracks hypothesis history for context accumulation across iterations.
// Stops on: verify pass, max iterations reached, or stuck detection.
//
// Terminology:
//   Step   — single unit of work
//   Queue  — mutable, ordered list of steps
// ---------------------------------------------------------------------------

import { randomUUID } from "crypto";
import type { Step, Queue } from "../../types";
import { insertAfter, type Provenance } from "../../queue";
import type { OnStepCompletedHook, OnStepCompletedResult } from "../../shared/hooks";
import { Log } from "../../../utils/log";

const log = Log.create({ service: "debug-loop" });

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

const DEBUG_PROVENANCE: Provenance = {
  actor: "debug-loop",
  reason: "debug fix-verify retry",
};

const MAX_DEBUG_ITERATIONS = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DebugIterationRecord {
  iteration: number;
  hypothesis: string | null;
  fixDescription: string | null;
  verificationOutput: { stdout?: string; stderr?: string; exitCode?: number } | null;
  passed: boolean;
}

export interface DebugLoopState {
  iterationCount: number;
  iterationHistory: DebugIterationRecord[];
  completed: boolean;
  maxIterationsReached: boolean;
}

// ---------------------------------------------------------------------------
// Stuck detection
// ---------------------------------------------------------------------------

function isStuck(history: DebugIterationRecord[]): boolean {
  if (history.length < 2) return false;
  const prev = history[history.length - 2];
  const curr = history[history.length - 1];
  if (!prev.verificationOutput || !curr.verificationOutput) return false;
  if (prev.passed || curr.passed) return false;
  return (
    prev.verificationOutput.stdout === curr.verificationOutput.stdout &&
    prev.verificationOutput.stderr === curr.verificationOutput.stderr &&
    prev.verificationOutput.exitCode === curr.verificationOutput.exitCode
  );
}

// ---------------------------------------------------------------------------
// createDebugQueueHandler — factory function
// ---------------------------------------------------------------------------

export function createDebugQueueHandler(): {
  onStepCompleted: OnStepCompletedHook;
  getState(): DebugLoopState;
} {
  let iterationCount = 0;
  const iterationHistory: DebugIterationRecord[] = [];
  let completed = false;
  let maxIterationsReached = false;

  function getState(): DebugLoopState {
    return {
      iterationCount,
      iterationHistory: [...iterationHistory],
      completed,
      maxIterationsReached,
    };
  }

  const onStepCompleted: OnStepCompletedHook = async (
    step: Step,
    status: "completed" | "failed",
    queue: Queue,
    handoffData: Record<string, unknown> | null,
  ): Promise<OnStepCompletedResult> => {
    // Track hypothesis from debug fix steps
    if (step.type === "debug" && step.dispatcherHint === "fix" && handoffData) {
      const hypothesis = typeof handoffData.hypothesis === "string" ? handoffData.hypothesis : null;
      const fixDesc = typeof handoffData.summary === "string" ? handoffData.summary : null;
      // Will be completed when verify step runs
      iterationHistory.push({
        iteration: iterationCount + 1,
        hypothesis,
        fixDescription: fixDesc,
        verificationOutput: null,
        passed: false,
      });
      return { continueExecution: false };
    }

    // Only handle verify steps with debug-verify hint
    if (step.type !== "verify" || step.dispatcherHint !== "debug-verify") {
      return { continueExecution: false };
    }

    // This is a debug verify step completing
    iterationCount++;

    // Extract verification result from handoff
    const verificationOutput = handoffData?.verification as
      | { tests_passed?: boolean; test_output_summary?: string }
      | undefined;

    // Determine if verification actually passed
    const actuallyPassed =
      status === "completed" &&
      (verificationOutput?.tests_passed === true);

    // Update or create iteration record with verification output
    if (iterationHistory.length > 0) {
      const last = iterationHistory[iterationHistory.length - 1];
      last.verificationOutput = {
        stdout: typeof handoffData?.summary === "string" ? handoffData.summary : undefined,
        stderr: undefined,
        exitCode: actuallyPassed ? 0 : 1,
      };
      last.passed = actuallyPassed;
    } else {
      iterationHistory.push({
        iteration: iterationCount,
        hypothesis: null,
        fixDescription: null,
        verificationOutput: {
          stdout: typeof handoffData?.summary === "string" ? handoffData.summary : undefined,
          exitCode: actuallyPassed ? 0 : 1,
        },
        passed: actuallyPassed,
      });
    }

    // Verify passed → debug complete
    if (status === "completed") {
      // Check handoff for actual pass/fail of the verification.
      // If no explicit verification data, treat completed as passed.
      if (!verificationOutput || verificationOutput.tests_passed !== false) {
        completed = true;
        log.info("debug verify passed, debug complete", { iteration: iterationCount });
        return { continueExecution: false };
      }
    }

    // Verify failed or reported tests_passed: false
    log.info("debug verify failed", { iteration: iterationCount, status });

    // Max iterations check
    if (iterationCount >= MAX_DEBUG_ITERATIONS) {
      maxIterationsReached = true;
      log.warn("debug max iterations reached", {
        iterations: iterationCount,
        max: MAX_DEBUG_ITERATIONS,
      });
      return { continueExecution: false };
    }

    // Stuck detection
    if (isStuck(iterationHistory)) {
      maxIterationsReached = true;
      log.warn("debug stuck — identical consecutive failures, stopping early", {
        iterations: iterationCount,
      });
      return { continueExecution: false };
    }

    // Insert retry [fix, verify] pair
    const fixStep: Step = {
      id: randomUUID(),
      type: "debug",
      title: `Fix (iteration ${iterationCount + 1})`,
      status: "pending",
      dispatcherHint: "fix",
      evaluationCriteria: "Fix applied with references documenting the change",
      toolScoping: { read: true, bash: true, write: true, edit: true, task: false },
    };

    const verifyStep: Step = {
      id: randomUUID(),
      type: "verify",
      title: `Verify fix (iteration ${iterationCount + 1})`,
      status: "pending",
      dispatcherHint: "debug-verify",
      evaluationCriteria: "Verification command output shows the issue is resolved",
      toolScoping: { read: true, bash: true, write: false, edit: false, task: false },
    };

    const result = insertAfter(queue, step.id, [fixStep, verifyStep], {
      ...DEBUG_PROVENANCE,
      reason: `debug fix-verify retry iteration ${iterationCount + 1}`,
    });

    if (result.success) {
      log.info("debug retry pair inserted", {
        iteration: iterationCount + 1,
        fixStepId: fixStep.id,
        verifyStepId: verifyStep.id,
      });
      return { continueExecution: true };
    } else {
      log.warn("failed to insert debug retry pair", {
        error: "error" in result ? result.error : "unknown",
      });
      return { continueExecution: false };
    }
  };

  return { onStepCompleted, getState };
}

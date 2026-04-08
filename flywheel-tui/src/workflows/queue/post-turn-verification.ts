// ---------------------------------------------------------------------------
// Post-Turn Verification — Factory for the verification hook
// ---------------------------------------------------------------------------
//
// Provides createPostTurnVerificationHook(), which the orchestrator calls
// to compose the full hook with stdin access. The step-runner just calls
// the hook — it doesn't know about stdin, native checks, or self-review.
// ---------------------------------------------------------------------------

import type { Step } from "./types.js";
import type { WorkerOutput, PostTurnVerificationResult } from "./executor-types.js";
import {
  runNativeVerification,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_DEADLINE_MS,
  type NativeCheckResult,
} from "../shared/native-verification.js";
import { extractDeclaredCommands } from "./shared/command-extraction.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface PostTurnVerificationConfig {
  /** Run native shell checks. */
  nativeChecks: boolean;
  /** Which native checks to run. */
  nativeCheckTypes: Array<"build" | "test" | "lint" | "has-changes">;
  /** Inject self-review checklist. */
  selfReview: boolean;
  /** Max fix attempts if native checks fail. Default: 2. */
  maxFixAttempts: number;
  /** Project working directory for native checks. */
  projectCwd: string;
}

// ---------------------------------------------------------------------------
// Self-review checklist (D5: 6-item checklist)
// ---------------------------------------------------------------------------

/** The self-review checklist injected via stdin. */
export const SELF_REVIEW_CHECKLIST = `Review your changes before completing:

1. **Diff review** — scan for obvious mistakes, unused imports, missing implementations, debug/temp code
2. **Task alignment** — all requested changes present? Any files mentioned in the task you didn't touch?
3. **Completeness** — any TODOs, placeholders, half-finished pieces? If acceptance criteria exist, verify each is met.
4. **Test coverage** — did you add/update tests for new behavior?
5. **Regression check** — could your changes break existing functionality?
6. **Edge cases** — obvious error handling gaps? Inputs that would break?

If you find issues: fix them now.
If everything looks good: confirm in your handoff.`;

// ---------------------------------------------------------------------------
// Step type sets
// ---------------------------------------------------------------------------

/** Step types that get native checks + self-review. */
const CODE_STEP_TYPES = new Set(["work", "debug"]);

/** Step types that get native git checks only (no self-review). */
const SHIP_STEP_TYPES = new Set(["ship"]);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the post-turn verification hook for a given config.
 * Returns a function that the step-runner calls after handoff read.
 *
 * The hook returns null for step types that don't need verification
 * (plan, review, research, verify, gate).
 */
export function createPostTurnVerificationHook(
  config: PostTurnVerificationConfig,
  stdinWrite?: (msg: string) => void,
  awaitNextTurn?: () => Promise<WorkerOutput>,
): (ctx: {
  step: Step;
  workerOutput: WorkerOutput;
  handoffData: Record<string, unknown> | null;
}) => Promise<PostTurnVerificationResult | null> {
  return async (ctx) => {
    const { step, handoffData } = ctx;

    // Non-code, non-ship steps: skip entirely
    if (!CODE_STEP_TYPES.has(step.type) && !SHIP_STEP_TYPES.has(step.type)) {
      return null;
    }

    let fixAttemptsUsed = 0;
    let nativeChecksPassed = true;
    let selfReviewCompleted = false;
    let checks: NativeCheckResult[] = [];

    // 1. Native checks (if configured)
    if (config.nativeChecks) {
      const declaredCommands = extractDeclaredCommands(handoffData);

      // For ship steps: only run has-changes
      const checkTypes = SHIP_STEP_TYPES.has(step.type)
        ? (["has-changes"] as const)
        : config.nativeCheckTypes;

      for (let attempt = 0; attempt <= config.maxFixAttempts; attempt++) {
        const result = await runNativeVerification({
          projectCwd: config.projectCwd,
          declaredCommands,
          nativeCheckTypes: [...checkTypes],
          timeoutMs: DEFAULT_TIMEOUT_MS,
          deadlineMs: DEFAULT_DEADLINE_MS,
        });

        checks = result.checks;

        if (result.allPassed && result.discrepancies.length === 0) {
          nativeChecksPassed = true;
          break;
        }

        nativeChecksPassed = false;

        // If we have stdin injection and more attempts left, inject fix prompt
        if (stdinWrite && awaitNextTurn && attempt < config.maxFixAttempts) {
          fixAttemptsUsed++;
          const feedback = result.checks
            .filter(c => !c.passed || c.discrepancy)
            .map(c => c.discrepancy
              ? `DISCREPANCY: \`${c.command}\` — you reported exit code ${c.reportedExitCode} but re-run got ${c.exitCode}\n${c.stderr.slice(0, 500)}`
              : `FAILED: \`${c.command}\` exited ${c.exitCode}\n${c.stderr.slice(0, 500)}`)
            .join("\n\n");

          stdinWrite(`Native verification failed. Fix these issues:\n\n${feedback}`);
          await awaitNextTurn();
        }
      }
    }

    // 2. Self-review (if configured and native checks passed)
    if (config.selfReview && nativeChecksPassed && CODE_STEP_TYPES.has(step.type)) {
      if (stdinWrite && awaitNextTurn) {
        stdinWrite(SELF_REVIEW_CHECKLIST);
        await awaitNextTurn();
        selfReviewCompleted = true;
      }
    }

    return {
      passed: nativeChecksPassed,
      nativeChecksPassed,
      selfReviewCompleted,
      fixAttemptsUsed,
      checks,
    };
  };
}

// Post-Turn Verification — Factory for the native check hook
//
// Runs native shell checks (build, test, lint, has-changes) after the worker
// declares done. If checks fail, injects fix feedback and retries. Self-review
// is handled separately by subprocess-callback at the turn boundary.

import type { Step } from "./types.js";
import type { WorkerOutput, PostTurnVerificationResult } from "./executor-types.js";
import {
  runNativeVerification,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_DEADLINE_MS,
  type NativeCheckResult,
} from "../shared/native-verification.js";
import { extractDeclaredCommands } from "./shared/command-extraction.js";

// Config

export interface PostTurnVerificationConfig {
  /** Which native checks to run. */
  nativeCheckTypes: Array<"build" | "test" | "lint" | "has-changes">;
  /** Max fix attempts if native checks fail. Default: 2. */
  maxFixAttempts: number;
  /** Project working directory for native checks. */
  projectCwd: string;
}

// Step type sets

/** Step types that get native checks. */
const CODE_STEP_TYPES = new Set(["work", "debug"]);

/** Step types that get native git checks only. */
const SHIP_STEP_TYPES = new Set(["ship"]);

// Factory

/**
 * Create the post-turn verification hook for a given config.
 * Returns a function that the step-runner calls after handoff read.
 *
 * Runs native checks and injects fix feedback on failure. Returns null
 * for step types that don't need verification (plan, review, research,
 * verify, gate).
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

    if (!CODE_STEP_TYPES.has(step.type) && !SHIP_STEP_TYPES.has(step.type)) {
      return null;
    }

    let fixAttemptsUsed = 0;
    let nativeChecksPassed = true;
    let checks: NativeCheckResult[] = [];

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

    return {
      passed: nativeChecksPassed,
      nativeChecksPassed,
      fixAttemptsUsed,
      checks,
    };
  };
}

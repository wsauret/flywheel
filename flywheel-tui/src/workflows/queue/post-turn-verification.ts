// Post-Turn Verification — Factory for the native check hook
//
// Runs native shell checks after the worker declares done. If checks fail,
// injects fix feedback and retries. Self-review is handled separately by
// subprocess-callback at the turn boundary.

import type { Step } from "./types.js";
import type { WorkerOutput, PostTurnVerificationResult } from "./executor-types.js";
import {
  runNativeVerification,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_DEADLINE_MS,
  type NativeCheckResult,
  type DeclaredCommand,
} from "../shared/native-verification.js";
import { parseRawHandoff } from "./shared/handoff-parse.js";

// Config

interface PostTurnVerificationConfig {
  /** Run git diff --stat to verify the worker made changes. */
  checkGitDiff: boolean;
  /** Max fix attempts if native checks fail. Default: 2. */
  maxFixAttempts: number;
  /** Project working directory for native checks. */
  projectCwd: string;
}

const CODE_STEP_TYPES = new Set(["work"]);

export function extractDeclaredCommands(
  handoffData: Record<string, unknown> | null,
): DeclaredCommand[] {
  if (!handoffData) return [];
  const parsed = parseRawHandoff(handoffData);
  const result: DeclaredCommand[] = [];
  for (const entry of parsed.commandsRun) {
    if (typeof entry === "string") {
      result.push({ command: entry });
    } else if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      if (typeof obj.command === "string") {
        result.push({
          command: obj.command,
          reportedExitCode: typeof obj.exitCode === "number" ? obj.exitCode : undefined,
          observation: typeof obj.observation === "string" ? obj.observation : undefined,
        });
      }
    }
  }
  return result;
}

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

    if (!CODE_STEP_TYPES.has(step.type)) {
      return null;
    }

    let passed = true;
    let checks: NativeCheckResult[] = [];

    const declaredCommands = extractDeclaredCommands(handoffData);

    for (let attempt = 0; attempt <= config.maxFixAttempts; attempt++) {
      const result = await runNativeVerification({
        projectCwd: config.projectCwd,
        declaredCommands,
        checkGitDiff: config.checkGitDiff,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        deadlineMs: DEFAULT_DEADLINE_MS,
      });

      checks = result.checks;

      if (result.allPassed) {
        passed = true;
        break;
      }

      passed = false;

      if (stdinWrite && awaitNextTurn && attempt < config.maxFixAttempts) {
        const feedback = result.checks
          .filter((c): c is Exclude<NativeCheckResult, { kind: "skipped" }> => c.kind !== "skipped" && !c.passed)
          .map(c => c.kind === "discrepancy"
            ? `DISCREPANCY: \`${c.command}\` — you reported exit code ${c.reportedExitCode} but re-run got ${c.exitCode}\n${c.stderr.slice(0, 500)}`
            : `FAILED: \`${c.command}\` exited ${c.exitCode}\n${c.stderr.slice(0, 500)}`)
          .join("\n\n");

        stdinWrite(`Native verification failed. Fix these issues:\n\n${feedback}`);
        await awaitNextTurn();
      }
    }

    return { passed, checks };
  };
}

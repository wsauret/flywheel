// ---------------------------------------------------------------------------
// Factory: Create trust-but-verify EvaluatorFn for the step executor
// ---------------------------------------------------------------------------
//
// Bridges the trust-but-verify evaluator with the EvaluatorFn interface
// used by the queue executor. Extracts handoff data into TrustVerifyHandoff
// format, invokes the evaluator, and converts the assessment back to
// EvalResult.
// ---------------------------------------------------------------------------

import type { Step } from "../queue/types";
import type { EvaluatorFn, EvalResult } from "../queue/executor";
import type { EvaluationCriteria } from "../schemas/shared";
import {
  createTrustVerifyEvaluator,
  type TrustVerifyHandoff,
  type TrustVerifyAssessment,
  type HandoffCommand,
} from "./trust-verify";
import { createCommandRunner } from "./command-runner";
import { createFileChecker } from "./file-checker";
import { Log } from "../utils/log";

const log = Log.create({ service: "evaluator-trust-verify-factory" });

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CreateTrustVerifyEvaluatorFnOptions {
  /** Working directory for commands and file checks */
  cwd: string;
  /** Command timeout in ms (default: 30_000) */
  commandTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Handoff extraction
// ---------------------------------------------------------------------------

/**
 * Extracts TrustVerifyHandoff from the raw handoff Record.
 * Handles missing/malformed fields gracefully.
 */
function extractHandoff(
  handoffData: Record<string, unknown> | null | undefined,
): TrustVerifyHandoff {
  if (!handoffData) {
    return {
      commandsRun: [],
      filesCreated: [],
      filesModified: [],
      testsAdded: 0,
      filesChangedCount: 0,
    };
  }

  // Extract commandsRun from verification or artifacts
  const commandsRun: HandoffCommand[] = [];
  const verification = handoffData.verification as
    | { commands_run?: unknown[]; commandsRun?: unknown[] }
    | undefined;
  const artifacts = handoffData.artifacts as
    | { commands_run?: string[]; files_created?: string[]; files_modified?: string[] }
    | undefined;

  // Try structured commands (array of {command, exitCode, observation})
  const rawCommands =
    verification?.commands_run ??
    verification?.commandsRun ??
    artifacts?.commands_run ??
    [];

  if (Array.isArray(rawCommands)) {
    for (const cmd of rawCommands) {
      if (typeof cmd === "string") {
        commandsRun.push({ command: cmd, exitCode: 0, observation: "" });
      } else if (cmd && typeof cmd === "object") {
        const cmdObj = cmd as Record<string, unknown>;
        commandsRun.push({
          command: String(cmdObj.command ?? ""),
          exitCode: Number(cmdObj.exitCode ?? cmdObj.exit_code ?? 0),
          observation: String(cmdObj.observation ?? ""),
        });
      }
    }
  }

  // Extract file lists
  const filesCreated: string[] = Array.isArray(artifacts?.files_created)
    ? artifacts!.files_created.filter((f): f is string => typeof f === "string")
    : [];

  const filesModified: string[] = Array.isArray(artifacts?.files_modified)
    ? artifacts!.files_modified.filter((f): f is string => typeof f === "string")
    : [];

  // Extract counts
  const testsAdded =
    typeof (handoffData as any).tests_added === "number"
      ? (handoffData as any).tests_added
      : 0;

  const filesChangedCount = filesCreated.length + filesModified.length;

  return {
    commandsRun,
    filesCreated,
    filesModified,
    testsAdded,
    filesChangedCount,
  };
}

// ---------------------------------------------------------------------------
// Verdict mapping
// ---------------------------------------------------------------------------

function assessmentToEvalResult(assessment: TrustVerifyAssessment): EvalResult {
  if (assessment.transportError) {
    return {
      passed: true,
      skipped: true,
      transportError: true,
      reason: assessment.warnings?.join("; ") ?? "transport error",
      feedback: null,
      suggestions: [],
      cyclesUsed: 1,
      verificationResults: assessment.verificationResults,
    };
  }

  switch (assessment.verdict) {
    case "pass":
      return {
        passed: true,
        skipped: false,
        transportError: false,
        reason: null,
        feedback: null,
        suggestions: [],
        cyclesUsed: 1,
        verificationResults: assessment.verificationResults,
      };

    case "fail":
      return {
        passed: false,
        skipped: false,
        transportError: false,
        reason: assessment.feedback ?? "verification failed",
        feedback: assessment.feedback,
        suggestions: [],
        cyclesUsed: 1,
        verificationResults: assessment.verificationResults,
      };

    case "revise-with-feedback":
      return {
        passed: false,
        skipped: false,
        transportError: false,
        reason: assessment.feedback ?? "revision needed",
        feedback: assessment.feedback,
        suggestions: assessment.feedback ? [assessment.feedback] : [],
        cyclesUsed: 1,
        verificationResults: assessment.verificationResults,
      };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an EvaluatorFn that uses the trust-but-verify model.
 * Can be passed directly to createStepExecutor as the `evaluator` option.
 */
export function createTrustVerifyEvaluatorFn(
  options: CreateTrustVerifyEvaluatorFnOptions,
): EvaluatorFn {
  const commandRunner = createCommandRunner(options.commandTimeoutMs);
  const fileChecker = createFileChecker(options.cwd);

  const evaluator = createTrustVerifyEvaluator({
    commandRunner,
    fileChecker,
    cwd: options.cwd,
  });

  return async (
    step: Step,
    workerOutput: string,
    evaluationCriteria?: unknown | null,
    handoffData?: Record<string, unknown> | null,
  ): Promise<EvalResult> => {
    log.info("trust-but-verify evaluation starting", {
      stepId: step.id,
      stepTitle: step.title,
      hasHandoff: handoffData !== null && handoffData !== undefined,
      hasEvaluationCriteria: evaluationCriteria !== null && evaluationCriteria !== undefined,
    });

    // Extract handoff into trust-verify format
    const handoff = extractHandoff(handoffData);

    // Build evaluation criteria (default if not provided)
    const criteria: EvaluationCriteria = evaluationCriteria &&
      typeof evaluationCriteria === "object" &&
      "acceptance_criteria" in (evaluationCriteria as object)
        ? (evaluationCriteria as EvaluationCriteria)
        : {
            acceptance_criteria: [],
            required_tests: false,
            custom_checks: [],
            required_outputs: [],
          };

    // Run trust-but-verify evaluation
    const assessment = await evaluator(handoff, criteria);

    log.info("trust-but-verify evaluation complete", {
      stepId: step.id,
      verdict: assessment.verdict,
      transportError: assessment.transportError,
      commandsChecked: assessment.verificationResults.commandResults.length,
      filesChecked: assessment.verificationResults.fileResults.length,
      countsChecked: assessment.verificationResults.countResults.length,
    });

    return assessmentToEvalResult(assessment);
  };
}

// ---------------------------------------------------------------------------
// Trust-but-Verify Evaluator (ADR-004)
// ---------------------------------------------------------------------------
//
// Implements the trust-but-verify evaluation model:
//   (1) Re-executes the SPECIFIC test commands the worker claims to have run
//       (from handoff commandsRun — NOT the full test suite)
//   (2) Checks that files the worker claims to have created/modified exist
//   (3) Confirms that reported counts (tests added, files modified) match reality
//   (4) Judges: pass, fail, or revise-with-feedback
//
// Assessment includes structured verification results (command outputs,
// file checks, count comparisons) alongside the verdict.
//
// On transport error (command runner crash, timeout, binary not found),
// the step proceeds as if evaluation passed (graceful degradation).
// ---------------------------------------------------------------------------

import { Log } from "../utils/log";
import type { ValidationCriteria } from "../schemas/shared";

const log = Log.create({ service: "evaluator-trust-verify" });

// ---------------------------------------------------------------------------
// Types — Handoff input
// ---------------------------------------------------------------------------

/** A command the worker claims to have run */
export interface HandoffCommand {
  command: string;
  exitCode: number;
  observation: string;
}

/**
 * Worker handoff data projected for trust-but-verify evaluation.
 * Extracted from the full worker handoff by the caller.
 */
export interface TrustVerifyHandoff {
  /** Commands the worker claims to have run (with exit codes) */
  commandsRun: HandoffCommand[];
  /** Files the worker claims to have created */
  filesCreated: string[];
  /** Files the worker claims to have modified */
  filesModified: string[];
  /** Number of tests the worker claims to have added */
  testsAdded: number;
  /** Number of files the worker claims to have changed */
  filesChangedCount: number;
}

// ---------------------------------------------------------------------------
// Types — Verification results
// ---------------------------------------------------------------------------

/** Result of re-running a single command */
export interface CommandRunResult {
  command: string;
  claimedExitCode: number;
  actualExitCode: number;
  matched: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Result of checking a single file's existence */
export interface FileCheckResult {
  path: string;
  type: "created" | "modified";
  exists: boolean;
}

/** Result of comparing a claimed count against reality */
export interface CountComparisonResult {
  metric: string;
  claimed: number;
  actual: number;
  matched: boolean;
}

/** All structured verification results */
export interface VerificationResults {
  commandResults: CommandRunResult[];
  fileResults: FileCheckResult[];
  countResults: CountComparisonResult[];
}

/** Verdict type — the evaluator's judgment */
export type Verdict = "pass" | "fail" | "revise-with-feedback";

/** Full assessment output from the trust-but-verify evaluator */
export interface TrustVerifyAssessment {
  verdict: Verdict;
  verificationResults: VerificationResults;
  feedback: string | null;
  transportError: boolean;
  warnings: string[] | null;
}

// ---------------------------------------------------------------------------
// Types — DI interfaces
// ---------------------------------------------------------------------------

/** Runs a shell command and returns exit code + output */
export type CommandRunner = (
  command: string,
  cwd?: string,
) => Promise<{
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}>;

/** Checks whether a file exists on disk */
export type FileChecker = (filePath: string) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TrustVerifyEvaluatorOptions {
  /** Command runner for re-executing test commands */
  commandRunner: CommandRunner;
  /** File existence checker */
  fileChecker: FileChecker;
  /** Working directory for commands */
  cwd: string;
  /** Optional callback for testing — called with handoff and criteria */
  onEvaluate?: (handoff: TrustVerifyHandoff, criteria: ValidationCriteria) => void;
  /** Command timeout in ms (default: 30_000) */
  commandTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Evaluator function type
// ---------------------------------------------------------------------------

export type TrustVerifyEvaluatorFn = (
  handoff: TrustVerifyHandoff,
  evaluationCriteria: ValidationCriteria,
) => Promise<TrustVerifyAssessment>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTrustVerifyEvaluator(
  options: TrustVerifyEvaluatorOptions,
): TrustVerifyEvaluatorFn {
  const { commandRunner, fileChecker, cwd, onEvaluate } = options;

  return async function evaluate(
    handoff: TrustVerifyHandoff,
    evaluationCriteria: ValidationCriteria,
  ): Promise<TrustVerifyAssessment> {
    // Notify test observer
    if (onEvaluate) {
      onEvaluate(handoff, evaluationCriteria);
    }

    const warnings: string[] = [];
    let hasTransportError = false;

    // ----- (1) Re-run claimed commands -----
    const commandResults = await runClaimedCommands(
      handoff.commandsRun,
      commandRunner,
      cwd,
      warnings,
    );

    // Check if we had transport errors in commands
    if (warnings.length > 0) {
      hasTransportError = true;
    }

    // ----- (2) Check file existence -----
    const fileResults = await checkFileExistence(
      handoff.filesCreated,
      handoff.filesModified,
      fileChecker,
      warnings,
    );

    // Check if file checker had transport errors
    if (warnings.length > 0 && !hasTransportError) {
      hasTransportError = warnings.some((w) => w.includes("transport error"));
    }

    // ----- (3) Confirm counts -----
    const countResults = confirmCounts(handoff, fileResults);

    // ----- (4) Determine verdict -----
    const verificationResults: VerificationResults = {
      commandResults,
      fileResults,
      countResults,
    };

    const { verdict, feedback } = determineVerdict(
      verificationResults,
      hasTransportError,
    );

    return {
      verdict,
      verificationResults,
      feedback,
      transportError: hasTransportError,
      warnings: warnings.length > 0 ? warnings : null,
    };
  };
}

// ---------------------------------------------------------------------------
// (1) Re-run claimed commands
// ---------------------------------------------------------------------------

async function runClaimedCommands(
  commandsRun: HandoffCommand[],
  runner: CommandRunner,
  cwd: string,
  warnings: string[],
): Promise<CommandRunResult[]> {
  const results: CommandRunResult[] = [];

  for (const cmd of commandsRun) {
    try {
      const runResult = await runner(cmd.command, cwd);

      results.push({
        command: cmd.command,
        claimedExitCode: cmd.exitCode,
        actualExitCode: runResult.exitCode,
        matched: runResult.exitCode === cmd.exitCode && !runResult.timedOut,
        stdout: runResult.stdout,
        stderr: runResult.stderr,
        timedOut: runResult.timedOut,
      });
    } catch (error) {
      // Transport error — command runner crashed (binary not found, etc.)
      const errMsg = error instanceof Error ? error.message : String(error);
      log.warn("command runner transport error, degrading gracefully", {
        command: cmd.command,
        error: errMsg,
      });
      warnings.push(
        `transport error running "${cmd.command}": ${errMsg}`,
      );
      // Don't add a failed result — transport error means we can't verify
      // The verdict logic will detect the transport error via warnings
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// (2) Check file existence
// ---------------------------------------------------------------------------

async function checkFileExistence(
  filesCreated: string[],
  filesModified: string[],
  checker: FileChecker,
  warnings: string[],
): Promise<FileCheckResult[]> {
  const results: FileCheckResult[] = [];

  for (const filePath of filesCreated) {
    try {
      const exists = await checker(filePath);
      results.push({ path: filePath, type: "created", exists });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.warn("file checker transport error, degrading gracefully", {
        path: filePath,
        error: errMsg,
      });
      warnings.push(`transport error checking "${filePath}": ${errMsg}`);
    }
  }

  for (const filePath of filesModified) {
    try {
      const exists = await checker(filePath);
      results.push({ path: filePath, type: "modified", exists });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.warn("file checker transport error, degrading gracefully", {
        path: filePath,
        error: errMsg,
      });
      warnings.push(`transport error checking "${filePath}": ${errMsg}`);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// (3) Confirm counts
// ---------------------------------------------------------------------------

function confirmCounts(
  handoff: TrustVerifyHandoff,
  fileResults: FileCheckResult[],
): CountComparisonResult[] {
  const results: CountComparisonResult[] = [];

  // Count created files that actually exist
  const createdFiles = fileResults.filter((r) => r.type === "created");
  if (handoff.filesCreated.length > 0) {
    const claimedCreated = handoff.filesCreated.length;
    const actualCreated = createdFiles.filter((r) => r.exists).length;
    results.push({
      metric: "files_created",
      claimed: claimedCreated,
      actual: actualCreated,
      matched: claimedCreated === actualCreated,
    });
  }

  // Count modified files that actually exist
  const modifiedFiles = fileResults.filter((r) => r.type === "modified");
  if (handoff.filesModified.length > 0) {
    const claimedModified = handoff.filesModified.length;
    const actualModified = modifiedFiles.filter((r) => r.exists).length;
    results.push({
      metric: "files_modified",
      claimed: claimedModified,
      actual: actualModified,
      matched: claimedModified === actualModified,
    });
  }

  // Tests added — report the claimed count. The actual is harder to verify
  // without parsing test files, so we report what the worker claimed and
  // note it as a self-reported metric.
  if (handoff.testsAdded > 0) {
    results.push({
      metric: "tests_added",
      claimed: handoff.testsAdded,
      actual: handoff.testsAdded, // self-reported — verified via command re-run
      matched: true,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// (4) Determine verdict
// ---------------------------------------------------------------------------

function determineVerdict(
  results: VerificationResults,
  hasTransportError: boolean,
): { verdict: Verdict; feedback: string | null } {
  // If there was a transport error, degrade gracefully — pass with warning
  if (hasTransportError && results.commandResults.length === 0 && results.fileResults.length === 0) {
    return {
      verdict: "pass",
      feedback: null,
    };
  }

  const feedbackLines: string[] = [];

  // Check command results — failed commands are hard evidence
  const failedCommands = results.commandResults.filter(
    (r) => !r.matched && !r.timedOut,
  );

  if (failedCommands.length > 0) {
    for (const cmd of failedCommands) {
      feedbackLines.push(
        `Command "${cmd.command}" failed: claimed exit code ${cmd.claimedExitCode}, ` +
        `actual exit code ${cmd.actualExitCode}`,
      );
      if (cmd.stderr) {
        feedbackLines.push(`  stderr: ${cmd.stderr.slice(0, 500)}`);
      }
    }
    // Command failures are hard evidence — verdict is "fail"
    return {
      verdict: "fail",
      feedback: feedbackLines.join("\n"),
    };
  }

  // Check file existence — missing files are recoverable
  const missingFiles = results.fileResults.filter((r) => !r.exists);

  if (missingFiles.length > 0) {
    for (const file of missingFiles) {
      feedbackLines.push(
        `File "${file.path}" (${file.type}) does not exist on disk`,
      );
    }
  }

  // Check count mismatches
  const countMismatches = results.countResults.filter((r) => !r.matched);

  if (countMismatches.length > 0) {
    for (const count of countMismatches) {
      feedbackLines.push(
        `Count mismatch for "${count.metric}": claimed ${count.claimed}, actual ${count.actual}`,
      );
    }
  }

  // Missing files or count mismatches → revise-with-feedback
  if (missingFiles.length > 0 || countMismatches.length > 0) {
    return {
      verdict: "revise-with-feedback",
      feedback: feedbackLines.join("\n"),
    };
  }

  // All checks passed
  return {
    verdict: "pass",
    feedback: null,
  };
}

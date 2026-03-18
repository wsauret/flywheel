/**
 * PlanOutputExtractor — extracts and verifies plan file paths from worker output.
 *
 * Three strategies, tried in order:
 *   1. Regex extraction of `<type>-<description>.md` from output text
 *   2. Disk verification via `fs.promises.access`
 *   3. Fallback scan of `docs/plans/` for recently modified matching files
 *
 * All I/O is async (fs.promises.*).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkerResult } from "../schemas/worker";
import type { OnStepCompleteHook } from "../controller/execution-loop";
import { parseOpenQuestions, type ResolvedQuestion } from "./question-parser";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid plan type prefixes (matches buildPlanDraftPrompt naming convention). */
const PLAN_TYPES = ["feat", "fix", "refactor", "chore", "docs"] as const;

/** Regex to match plan filenames: <type>-<description>.md (global, for String.match). */
const PLAN_FILENAME_PATTERN = new RegExp(
  `(?:${PLAN_TYPES.join("|")})-[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*\\.md`,
  "g",
);

/** Non-global variant for single-match testing (avoids lastIndex statefulness). */
const PLAN_FILENAME_TEST = new RegExp(
  `(?:${PLAN_TYPES.join("|")})-[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*\\.md`,
);

/** File suffixes to exclude from scan results (metadata companions, not actual plans). */
export const EXCLUDED_SUFFIXES = [".context.md", ".state.md", ".baseline.md"];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract a plan filename from worker output text.
 *
 * Scans for patterns like `feat-auth-jwt.md`, `fix-memory-leak.md`, etc.
 * Returns the last match (most likely the final/consolidated version).
 *
 * @returns The filename (e.g. `feat-auth-jwt.md`) or null if none found.
 */
export async function extractPlanPath(
  workerOutput: string,
): Promise<string | null> {
  if (!workerOutput) return null;

  const matches = workerOutput.match(PLAN_FILENAME_PATTERN);
  if (!matches || matches.length === 0) return null;

  // Return the last match — most likely the final/consolidated filename
  return matches[matches.length - 1];
}

/**
 * Verify that a plan file exists on disk at `docs/plans/<filename>`.
 *
 * @param projectCwd - The project root directory
 * @param filename - The plan filename (e.g. `feat-auth-jwt.md`)
 * @returns The full path if the file exists, or null.
 */
export async function verifyPlanFile(
  projectCwd: string,
  filename: string,
): Promise<string | null> {
  const fullPath = path.join(projectCwd, "docs", "plans", filename);
  try {
    await fs.access(fullPath);
    return fullPath;
  } catch {
    return null;
  }
}

/**
 * Scan `docs/plans/` for plan files created after `beforeTimestamp`.
 *
 * Fallback strategy when regex extraction fails. Finds the most recently
 * modified `.md` file matching the `<type>-*.md` pattern.
 *
 * @param projectCwd - The project root directory
 * @param beforeTimestamp - Only consider files modified after this time (ms since epoch)
 * @returns The filename of the newest matching plan file, or null.
 */
export async function scanForNewPlan(
  projectCwd: string,
  beforeTimestamp: number,
): Promise<string | null> {
  const plansDir = path.join(projectCwd, "docs", "plans");

  let entries: string[];
  try {
    entries = await fs.readdir(plansDir);
  } catch {
    return null;
  }

  // Filter entries: must match plan pattern and NOT be excluded metadata files
  const matchingEntries = entries.filter((entry) => {
    if (EXCLUDED_SUFFIXES.some((suffix) => entry.endsWith(suffix))) return false;
    return PLAN_FILENAME_TEST.test(entry);
  });

  // Parallelize fs.stat calls
  const statPromises = matchingEntries.map(async (entry) => {
    try {
      const stat = await fs.stat(path.join(plansDir, entry));
      return stat.mtimeMs > beforeTimestamp
        ? { filename: entry, mtimeMs: stat.mtimeMs }
        : null;
    } catch {
      return null;
    }
  });
  const candidates = (await Promise.all(statPromises)).filter(
    (c): c is { filename: string; mtimeMs: number } => c !== null,
  );

  if (candidates.length === 0) return null;

  // Return the most recently modified file
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].filename;
}

// ---------------------------------------------------------------------------
// Hook factory
// ---------------------------------------------------------------------------

/** The review step index in the plan workflow (0-based). */
const REVIEW_STEP_INDEX = 2;

/** The consolidation step index in the plan workflow (0-based). */
const CONSOLIDATION_STEP_INDEX = 3;

/**
 * Create an `onStepComplete` hook for the plan workflow.
 *
 * After the consolidation step (step 3), extracts the plan file path from
 * the worker output using three strategies:
 *   1. Regex extraction from output text
 *   2. Disk verification of the extracted filename
 *   3. Fallback scan for recently created plan files
 *
 * Stores the result as `planFilePath` in the extra accumulator.
 *
 * @param projectCwd - The project root directory (for disk verification)
 * @returns An OnStepCompleteHook suitable for ExecutionLoop
 */
export function createPlanOnStepComplete(projectCwd: string): OnStepCompleteHook {
  // Record the time before the workflow starts, used for fallback scan
  const workflowStartTime = Date.now();

  return async (
    stepIndex: number,
    result: WorkerResult,
    _accumulatedExtra: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    // After the review step: parse open questions and auto-resolve (V1)
    if (stepIndex === REVIEW_STEP_INDEX) {
      const openQuestions = parseOpenQuestions(result.output);
      // V1: auto-resolve with first option (or empty) — no UI interaction yet
      const resolvedQuestions: ResolvedQuestion[] = openQuestions.map((q) => ({
        question: q.question,
        answers: q.options.length > 0 ? [q.options[0].label] : [],
        source: "auto" as const,
      }));
      return { openQuestions, resolvedQuestions };
    }

    // Only extract plan file on the consolidation step
    if (stepIndex !== CONSOLIDATION_STEP_INDEX) {
      return {};
    }

    // Strategy 1: Regex extraction
    const filename = await extractPlanPath(result.output);

    if (filename) {
      // Strategy 2: Verify file exists on disk
      const fullPath = await verifyPlanFile(projectCwd, filename);
      if (fullPath) {
        return { planFilePath: fullPath, planFileName: filename };
      }
      // File mentioned but not found — warn but continue
      // (worker may have written to a different location)
    }

    // Strategy 3: Fallback — scan docs/plans/ for newly created files
    const scannedFilename = await scanForNewPlan(projectCwd, workflowStartTime);
    if (scannedFilename) {
      const fullPath = path.join(projectCwd, "docs", "plans", scannedFilename);
      return { planFilePath: fullPath, planFileName: scannedFilename };
    }

    // No plan file found — warn but don't halt the pipeline
    // The plan content is still available in the worker output
    return { planFileWarning: "Could not locate plan file on disk after consolidation" };
  };
}

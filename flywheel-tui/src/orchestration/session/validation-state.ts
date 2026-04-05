/**
 * Validation state read/write utility.
 *
 * Manages `validation-state.json` — the file that tracks assertion
 * pass/fail/blocked status across milestones. Uses atomic writes
 * for safety (concurrent queue access).
 *
 * Adapted from multi-agent mission system validation patterns.
 */

import * as fs from "node:fs";
import { writeFileAtomic } from "../../workflows/shared/atomic-write";
import {
  ValidationStateSchema,
  type ValidationState,
} from "./validation-schemas";
import { Log } from "../../workflows/shared/log";

const log = Log.create({ service: "validation-state" });

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read and validate a `validation-state.json` file.
 *
 * @param filePath - Absolute path to validation-state.json
 * @returns Validated ValidationState or null if file does not exist
 * @throws If file exists but contains invalid data (Zod validation error)
 */
export function readValidationState(filePath: string): ValidationState | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  const result = ValidationStateSchema.parse(parsed);
  log.debug("read validation state", {
    path: filePath,
    assertionCount: Object.keys(result.assertions).length,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write a `validation-state.json` file atomically.
 *
 * Validates the data with Zod before writing. Creates parent
 * directories if they don't exist.
 *
 * @param filePath - Absolute path to validation-state.json
 * @param state - The validation state to write
 * @throws If state fails Zod validation
 */
export function writeValidationState(
  filePath: string,
  state: ValidationState,
): void {
  // Validate before writing
  ValidationStateSchema.parse(state);

  const content = JSON.stringify(state, null, 2) + "\n";
  writeFileAtomic(filePath, content);
  log.debug("wrote validation state", {
    path: filePath,
    assertionCount: Object.keys(state.assertions).length,
  });
}

// ---------------------------------------------------------------------------
// End-of-session gate
// ---------------------------------------------------------------------------

/**
 * A failed assertion reported by the end-of-session gate.
 */
export interface FailedAssertion {
  /** Assertion ID (e.g., "VAL-AUTH-001") */
  id: string;
  /** Human-readable title (falls back to ID if no title map provided) */
  title: string;
  /** Current status: "pending", "failed", or "blocked" */
  status: string;
}

/**
 * Result of the end-of-session validation gate check.
 */
export interface EndOfSessionGateResult {
  /** Whether all relevant assertions passed */
  passed: boolean;
  /** Assertions that did not pass (empty when passed is true) */
  failedAssertions: FailedAssertion[];
  /** Total number of assertions in the state file */
  totalAssertions: number;
  /** Number of assertions with status "passed" */
  passedCount: number;
}

/**
 * Options for the end-of-session gate check.
 */
export interface EndOfSessionGateOptions {
  /** Map of assertion ID → human-readable title. When provided, titles are used in failure reports. */
  assertionTitles?: Record<string, string>;
  /** If true, "pending" assertions are not treated as failures (scrutiny was skipped). */
  skipScrutiny?: boolean;
  /** If true, "pending" assertions are not treated as failures (behavioral validation was skipped). */
  skipValidation?: boolean;
}

/**
 * Check the validation state before declaring queue completion.
 *
 * This is the **end-of-session gate** — the final quality check before
 * a queue run is declared complete. It reads `validation-state.json` and
 * verifies that all assertions have passed.
 *
 * Behavior:
 * - If the file does not exist (no milestones / no validation contract),
 *   the gate passes — there's nothing to check.
 * - If all assertions are "passed", the gate passes.
 * - If any assertions are "failed" or "blocked", those are reported as failures.
 * - If any assertions are "pending":
 *   - With no skip flags: "pending" is treated as a failure (validation didn't run).
 *   - With `skipScrutiny` or `skipValidation` true: "pending" is tolerated
 *     because the validation that would have updated them was intentionally skipped.
 * - "blocked" is always treated as a failure regardless of skip flags.
 * - "failed" is always treated as a failure regardless of skip flags.
 *
 * Adapted from multi-agent mission system end-of-session quality gate concept.
 *
 * Fulfills: VAL-EXEC-007
 *
 * @param filePath - Absolute path to validation-state.json
 * @param options - Optional configuration (titles, skip flags)
 * @returns Gate result with pass/fail and details of any failures
 */
export function checkEndOfSessionGate(
  filePath: string,
  options: EndOfSessionGateOptions = {},
): EndOfSessionGateResult {
  const { assertionTitles = {}, skipScrutiny = false, skipValidation = false } = options;

  // If the file doesn't exist, there's nothing to validate — pass
  const state = readValidationState(filePath);
  if (!state) {
    log.info("end-of-session gate: no validation state file, passing", { path: filePath });
    return { passed: true, failedAssertions: [], totalAssertions: 0, passedCount: 0 };
  }

  const entries = Object.entries(state.assertions);
  const totalAssertions = entries.length;

  // Empty assertions map — nothing to validate
  if (totalAssertions === 0) {
    log.info("end-of-session gate: no assertions, passing", { path: filePath });
    return { passed: true, failedAssertions: [], totalAssertions: 0, passedCount: 0 };
  }

  const anySkipActive = skipScrutiny || skipValidation;
  const failedAssertions: FailedAssertion[] = [];
  let passedCount = 0;

  for (const [id, assertion] of entries) {
    if (assertion.status === "passed") {
      passedCount++;
      continue;
    }

    // "pending" is tolerable when validation was skipped (the assertion was
    // never checked because the validation type that checks it was skipped)
    if (assertion.status === "pending" && anySkipActive) {
      continue;
    }

    // "failed", "blocked", or "pending" without skip flags — report as failure
    failedAssertions.push({
      id,
      title: assertionTitles[id] ?? id,
      status: assertion.status,
    });
  }

  const passed = failedAssertions.length === 0;

  if (passed) {
    log.info("end-of-session gate: all assertions passed", {
      path: filePath,
      total: totalAssertions,
      passed: passedCount,
    });
  } else {
    log.warn("end-of-session gate: assertions not passed", {
      path: filePath,
      total: totalAssertions,
      passed: passedCount,
      failed: failedAssertions.length,
      failedIds: failedAssertions.map((a) => `${a.id}:${a.status}`).join(", "),
    });
  }

  return { passed, failedAssertions, totalAssertions, passedCount };
}



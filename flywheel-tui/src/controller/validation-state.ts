/**
 * Validation state read/write utility.
 *
 * Manages `validation-state.json` — the file that tracks assertion
 * pass/fail/blocked status across milestones. Uses atomic writes
 * for safety (concurrent pipeline access).
 *
 * Adapted from Droid's validation-state.json pattern
 * (see inspiration/droid/extracted/VALIDATION-SYSTEM-ANALYSIS.md §5).
 */

import * as fs from "node:fs";
import { writeFileAtomic } from "../utils/atomic-write";
import {
  ValidationStateSchema,
  type ValidationState,
} from "../schemas/validation";
import { Log } from "../utils/log";

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
// Initialize
// ---------------------------------------------------------------------------

/**
 * Create a new `validation-state.json` with all assertions set to "pending".
 *
 * Typically called during plan approval when a validation contract
 * is generated.
 *
 * @param filePath - Absolute path to validation-state.json
 * @param assertionIds - Array of assertion IDs from the validation contract
 */
export function initializeValidationState(
  filePath: string,
  assertionIds: string[],
): void {
  const state: ValidationState = {
    assertions: {},
  };

  for (const id of assertionIds) {
    state.assertions[id] = { status: "pending" };
  }

  writeValidationState(filePath, state);
  log.info("initialized validation state", {
    path: filePath,
    assertionCount: assertionIds.length,
  });
}

// ---------------------------------------------------------------------------
// Coverage check utility
// ---------------------------------------------------------------------------

/**
 * Result of checking assertion coverage across phases.
 */
export interface CoverageReport {
  /** Assertion IDs in the contract but not claimed by any phase */
  orphaned: string[];
  /** Assertion IDs claimed by multiple phases */
  duplicates: Array<{
    assertionId: string;
    claimedBy: string[];
  }>;
  /** Assertion IDs claimed by phases but not in the contract */
  unclaimed: string[];
  /** True when every contract assertion is claimed exactly once and no extras */
  isComplete: boolean;
}

/**
 * Check assertion coverage: every contract assertion should be claimed by
 * exactly one phase's `fulfills` array.
 *
 * @param contractAssertionIds - All assertion IDs from the validation contract
 * @param phases - Phases with optional fulfills arrays
 * @returns Coverage report with orphaned, duplicate, and unclaimed assertion IDs
 */
export function checkAssertionCoverage(
  contractAssertionIds: string[],
  phases: ReadonlyArray<{ title: string; fulfills?: string[] }>,
): CoverageReport {
  // Build a map: assertion ID → list of phase titles that claim it
  const claimedBy = new Map<string, string[]>();

  for (const phase of phases) {
    if (!phase.fulfills) continue;
    for (const id of phase.fulfills) {
      const existing = claimedBy.get(id) ?? [];
      existing.push(phase.title);
      claimedBy.set(id, existing);
    }
  }

  const contractSet = new Set(contractAssertionIds);

  // Orphaned: in contract but not claimed by any phase
  const orphaned = contractAssertionIds.filter((id) => !claimedBy.has(id));

  // Duplicates: claimed by more than one phase
  const duplicates: CoverageReport["duplicates"] = [];
  for (const [id, titles] of claimedBy) {
    if (titles.length > 1 && contractSet.has(id)) {
      duplicates.push({ assertionId: id, claimedBy: titles });
    }
  }

  // Unclaimed: claimed by phases but not in contract
  const unclaimed: string[] = [];
  for (const [id] of claimedBy) {
    if (!contractSet.has(id)) {
      unclaimed.push(id);
    }
  }

  const isComplete =
    orphaned.length === 0 &&
    duplicates.length === 0;

  return { orphaned, duplicates, unclaimed, isComplete };
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
 * Check the validation state before declaring pipeline completion.
 *
 * This is the **end-of-session gate** — the final quality check before
 * a pipeline is declared complete. It reads `validation-state.json` and
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
 * Adapted from Droid's end-of-session quality gate concept
 * (see inspiration/droid/extracted/VALIDATION-SYSTEM-ANALYSIS.md §5).
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

// ---------------------------------------------------------------------------
// Update assertion statuses (used after validation phases)
// ---------------------------------------------------------------------------

/**
 * Status update for a single assertion.
 */
export interface AssertionStatusUpdate {
  /** New status for the assertion */
  status: "passed" | "failed" | "blocked";
  /** Evidence or reason for the status */
  evidence?: string;
}

/**
 * Update assertion statuses in a `validation-state.json` file.
 *
 * Reads the existing state (or creates a new one if the file doesn't exist),
 * applies the provided updates, and writes the result atomically.
 *
 * - `lastChecked` is automatically set to the current ISO timestamp for
 *   each updated assertion.
 * - Assertions not included in the `updates` map are preserved unchanged.
 * - If the file does not exist, a new state is created with only the
 *   updated assertions.
 *
 * @param filePath - Absolute path to validation-state.json
 * @param updates - Map of assertion ID → status update
 */
export function updateAssertionStatuses(
  filePath: string,
  updates: Record<string, AssertionStatusUpdate>,
): void {
  const updateKeys = Object.keys(updates);
  if (updateKeys.length === 0) return;

  // Load existing state or create empty
  let state = readValidationState(filePath);
  if (!state) {
    state = { assertions: {} };
  }

  const now = new Date().toISOString();

  for (const [id, update] of Object.entries(updates)) {
    state.assertions[id] = {
      ...state.assertions[id],
      status: update.status,
      lastChecked: now,
      ...(update.evidence !== undefined ? { evidence: update.evidence } : {}),
    };
  }

  writeValidationState(filePath, state);
  log.info("updated assertion statuses", {
    path: filePath,
    updatedCount: updateKeys.length,
    statuses: updateKeys.map((id) => `${id}:${updates[id].status}`).join(", "),
  });
}

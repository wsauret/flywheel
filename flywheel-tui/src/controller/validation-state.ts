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

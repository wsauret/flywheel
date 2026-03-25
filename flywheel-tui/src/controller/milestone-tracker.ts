/**
 * MilestoneTracker — tracks milestone completion and validation injection state.
 *
 * Adapted from multi-agent mission system milestone completion and
 * validation planning patterns.
 *
 * A milestone is "implementation complete" when all non-validation phases
 * in that milestone are either "completed" or "cancelled". Validation-type
 * phases (scrutiny-validator, user-testing-validator) are excluded from
 * this check to prevent circular dependency.
 *
 * The `milestonesWithValidationPlanned` array prevents re-injection of
 * validation phases after a milestone has been sealed.
 */

import type { PhaseInfo } from "./phase-provider";
import { Log } from "../utils/log";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Skill names that indicate validation-type phases.
 * These are excluded from milestone completion checks.
 *
 * Matches the validation system's validator skill names.
 */
export const VALIDATION_SKILL_NAMES: readonly string[] = Object.freeze([
  "scrutiny-validator",
  "user-testing-validator",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal phase representation for milestone tracking.
 *
 * This is a subset of PhaseInfo — callers should project their phase data
 * into this shape. The `isValidation` flag indicates whether the phase is
 * a validation-type phase (scrutiny, behavioral testing).
 */
export interface MilestonePhase {
  /** 0-based index */
  index: number;
  /** Phase title */
  title: string;
  /** Execution status */
  status: "completed" | "pending" | "in_progress" | "cancelled";
  /** Milestone this phase belongs to (undefined = no milestone) */
  milestone?: string;
  /**
   * Whether this phase is a validation-type phase.
   * Validation phases are excluded from milestone completion checks.
   */
  isValidation: boolean;
}

// ---------------------------------------------------------------------------
// Pure function: milestone implementation completeness check
// ---------------------------------------------------------------------------

const log = Log.create({ service: "milestone-tracker" });

/**
 * Check whether all non-validation phases in a milestone are complete.
 *
 * A milestone is "implementation complete" when:
 * 1. There is at least one non-validation phase in the milestone
 * 2. All non-validation phases have status "completed" or "cancelled"
 *
 * Adapted from multi-agent mission system milestone completion detection.
 *
 * @param phases - All phases (including from other milestones)
 * @param milestoneName - The milestone to check
 * @returns true if all implementation phases in the milestone are done
 */
export function isMilestoneImplementationComplete(
  phases: readonly MilestonePhase[],
  milestoneName: string,
): boolean {
  // Filter to phases belonging to this milestone
  const milestonePhases = phases.filter((p) => p.milestone === milestoneName);
  if (milestonePhases.length === 0) return false;

  // Filter out validation-type phases
  const implementationPhases = milestonePhases.filter((p) => !p.isValidation);
  if (implementationPhases.length === 0) return false;

  // All implementation phases must be completed or cancelled
  return implementationPhases.every(
    (p) => p.status === "completed" || p.status === "cancelled",
  );
}

// ---------------------------------------------------------------------------
// MilestoneTracker class
// ---------------------------------------------------------------------------

/**
 * Stateful tracker for milestone completion and validation injection.
 *
 * Maintains the `milestonesWithValidationPlanned` array to prevent
 * duplicate injection of validation phases for the same milestone.
 *
 * Usage:
 * ```ts
 * const tracker = new MilestoneTracker();
 *
 * // After each phase completes, check for newly completed milestones
 * const completed = tracker.checkCompletedMilestones(phases);
 * for (const milestone of completed) {
 *   // Inject validation phases...
 *   tracker.markValidationPlanned(milestone);
 * }
 * ```
 */
export class MilestoneTracker {
  /**
   * Milestones that have already had validation phases injected.
   * Prevents re-injection after fix phases cause re-completion.
   *
   * Prevents re-injection after fix phases cause re-completion.
   */
  private readonly _sealedMilestones: Set<string>;

  /**
   * @param initialSealed - Pre-sealed milestone names (e.g., loaded from persisted state)
   */
  constructor(initialSealed?: string[]) {
    this._sealedMilestones = new Set(initialSealed ?? []);
  }

  /**
   * Check whether a milestone's implementation phases are all complete.
   * Delegates to the pure `isMilestoneImplementationComplete` function.
   */
  isMilestoneComplete(phases: readonly MilestonePhase[], milestoneName: string): boolean {
    return isMilestoneImplementationComplete(phases, milestoneName);
  }

  /**
   * Check whether validation has already been planned for a milestone.
   */
  hasValidationPlanned(milestoneName: string): boolean {
    return this._sealedMilestones.has(milestoneName);
  }

  /**
   * Mark a milestone as having validation planned (sealed).
   * Idempotent — calling multiple times has no additional effect.
   */
  markValidationPlanned(milestoneName: string): void {
    if (this._sealedMilestones.has(milestoneName)) {
      log.debug("milestone already sealed, skipping", { milestone: milestoneName });
      return;
    }
    this._sealedMilestones.add(milestoneName);
    log.info("milestone sealed for validation", { milestone: milestoneName });
  }

  /**
   * Determine whether validation should be injected for a milestone.
   *
   * Returns true when:
   * 1. The milestone's implementation phases are all complete
   * 2. Validation has NOT already been planned for this milestone
   *
   * Combined guard: checks implementation completeness and sealed state.
   */
  shouldInjectValidation(phases: readonly MilestonePhase[], milestoneName: string): boolean {
    if (this._sealedMilestones.has(milestoneName)) return false;
    return isMilestoneImplementationComplete(phases, milestoneName);
  }

  /**
   * Get all unique milestone names from phases (excluding undefined).
   * Returns in insertion order (first appearance).
   */
  getMilestoneNames(phases: readonly MilestonePhase[]): string[] {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const phase of phases) {
      if (phase.milestone && !seen.has(phase.milestone)) {
        seen.add(phase.milestone);
        names.push(phase.milestone);
      }
    }
    return names;
  }

  /**
   * Get the list of milestones that have had validation planned.
   * Useful for persistence/serialization.
   */
  getMilestonesWithValidationPlanned(): string[] {
    return [...this._sealedMilestones];
  }

  /**
   * Check all milestones for newly completed ones that haven't been sealed.
   *
   * Returns milestone names that are:
   * 1. Implementation complete (all non-validation phases done)
   * 2. Not yet sealed (validation not yet planned)
   *
   * Scans all milestones and returns those ready for validation injection.
   */
  checkCompletedMilestones(phases: readonly MilestonePhase[]): string[] {
    const milestoneNames = this.getMilestoneNames(phases);
    const newlyCompleted: string[] = [];

    for (const name of milestoneNames) {
      if (this.shouldInjectValidation(phases, name)) {
        newlyCompleted.push(name);
      }
    }

    return newlyCompleted;
  }

  /**
   * Create validation phases for a completed milestone and return them
   * in the order they should be injected (scrutiny first, then behavioral).
   *
   * Adapted from multi-agent mission system validation injection patterns:
   * - Scrutiny phase: runs test/typecheck/lint + per-phase code review
   * - Behavioral validation phase: tests assertions from fulfills fields
   *
   * Skip flags control which phases are created:
   * - `skipScrutiny`: omit scrutiny phase
   * - `skipValidation`: omit behavioral validation phase
   *
   * When both are skipped, returns empty array and still marks milestone sealed.
   *
   * @param milestoneName - The milestone that just completed
   * @param startIndex - Starting 0-based index for the new phases
   * @param options - Skip flags for scrutiny and/or behavioral validation
   * @returns Array of PhaseInfo objects to prepend to the phase queue
   */
  createValidationPhases(
    milestoneName: string,
    startIndex: number,
    options: { skipScrutiny?: boolean; skipValidation?: boolean } = {},
  ): PhaseInfo[] {
    const { skipScrutiny = false, skipValidation = false } = options;

    if (skipScrutiny && skipValidation) {
      log.info("both validation types skipped for milestone", { milestone: milestoneName });
      return [];
    }

    const phases: PhaseInfo[] = [];
    let idx = startIndex;

    // Scrutiny validation phase (runs first)
    if (!skipScrutiny) {
      phases.push({
        index: idx++,
        title: `Scrutiny: ${milestoneName}`,
        description: [
          `Scrutiny validation for milestone "${milestoneName}".`,
          "Run the project's test suite, typecheck, and lint as hard gates.",
          "Review each completed phase in the milestone for code quality, correctness, and test coverage.",
          "Synthesize findings into a scrutiny report.",
        ].join(" "),
        status: "pending",
        steps: [
          "Run test suite",
          "Run typecheck",
          "Run lint",
          "Review completed phases",
          "Synthesize findings",
        ],
        milestone: milestoneName,
      });
    }

    // Behavioral validation phase (runs after scrutiny)
    if (!skipValidation) {
      phases.push({
        index: idx++,
        title: `Validation: ${milestoneName}`,
        description: [
          `Behavioral validation for milestone "${milestoneName}".`,
          "Read the validation contract and identify assertions from completed phases' fulfills fields.",
          "Verify each assertion's behavioral description is satisfied.",
          "Update validation-state.json with pass/fail/blocked per assertion.",
        ].join(" "),
        status: "pending",
        steps: [
          "Read validation contract",
          "Identify testable assertions from fulfills",
          "Verify each assertion",
          "Update validation-state.json",
        ],
        milestone: milestoneName,
      });
    }

    return phases;
  }

  /**
   * Check for milestone completion and create validation phases to inject.
   *
   * This is the main entry point for the execution loop to call after
   * a phase completes. It combines milestone detection, skip flag handling,
   * and phase creation.
   *
   * Adapted from multi-agent mission system validation injection patterns.
   *
   * @param phases - Current phase list (as MilestonePhase projections)
   * @param startIndex - Index at which to start numbering injected phases
   * @param options - Skip flags
   * @returns Object with milestone name and phases to inject, or null if nothing to inject
   */
  checkAndCreateValidationPhases(
    phases: readonly MilestonePhase[],
    startIndex: number,
    options: { skipScrutiny?: boolean; skipValidation?: boolean } = {},
  ): Array<{ milestone: string; phases: PhaseInfo[] }> {
    const completedMilestones = this.checkCompletedMilestones(phases);
    if (completedMilestones.length === 0) return [];

    const results: Array<{ milestone: string; phases: PhaseInfo[] }> = [];
    let currentIndex = startIndex;

    for (const milestone of completedMilestones) {
      const validationPhases = this.createValidationPhases(milestone, currentIndex, options);

      // Mark milestone as sealed (even if all phases were skipped)
      this.markValidationPlanned(milestone);

      if (validationPhases.length > 0) {
        results.push({ milestone, phases: validationPhases });
        currentIndex += validationPhases.length;
      }
    }

    return results;
  }
}

/**
 * MilestoneTracker — tracks milestone completion and validation injection state.
 *
 * Adapted from multi-agent mission system milestone completion and
 * validation planning patterns.
 *
 * A milestone is "implementation complete" when all non-validation steps
 * in that milestone are either "completed" or "cancelled". Validation-type
 * steps (scrutiny-validator, user-testing-validator) are excluded from
 * this check to prevent circular dependency.
 *
 * The `milestonesWithValidationPlanned` array prevents re-injection of
 * validation steps after a milestone has been sealed.
 */

import type { StepInfo } from "./step-provider";
import { Log } from "../utils/log";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Skill names that indicate validation-type steps.
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
 * Minimal step representation for milestone tracking.
 *
 * This is a subset of StepInfo — callers should project their step data
 * into this shape. The `isValidation` flag indicates whether the step is
 * a validation-type step (scrutiny, behavioral testing).
 */
export interface MilestoneStep {
  /** 0-based index */
  index: number;
  /** Step title */
  title: string;
  /** Execution status */
  status: "completed" | "pending" | "in_progress" | "cancelled";
  /** Milestone this step belongs to (undefined = no milestone) */
  milestone?: string;
  /**
   * Whether this step is a validation-type step.
   * Validation steps are excluded from milestone completion checks.
   */
  isValidation: boolean;
}

// ---------------------------------------------------------------------------
// Pure function: milestone implementation completeness check
// ---------------------------------------------------------------------------

const log = Log.create({ service: "milestone-tracker" });

/**
 * Check whether all non-validation steps in a milestone are complete.
 *
 * A milestone is "implementation complete" when:
 * 1. There is at least one non-validation step in the milestone
 * 2. All non-validation steps have status "completed" or "cancelled"
 *
 * Adapted from multi-agent mission system milestone completion detection.
 *
 * @param steps - All steps (including from other milestones)
 * @param milestoneName - The milestone to check
 * @returns true if all implementation steps in the milestone are done
 */
export function isMilestoneImplementationComplete(
  steps: readonly MilestoneStep[],
  milestoneName: string,
): boolean {
  // Filter to steps belonging to this milestone
  const milestoneSteps = steps.filter((p) => p.milestone === milestoneName);
  if (milestoneSteps.length === 0) return false;

  // Filter out validation-type steps
  const implementationSteps = milestoneSteps.filter((p) => !p.isValidation);
  if (implementationSteps.length === 0) return false;

  // All implementation steps must be completed or cancelled
  return implementationSteps.every(
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
 * duplicate injection of validation steps for the same milestone.
 *
 * Usage:
 * ```ts
 * const tracker = new MilestoneTracker();
 *
 * // After each step completes, check for newly completed milestones
 * const completed = tracker.checkCompletedMilestones(steps);
 * for (const milestone of completed) {
 *   // Inject validation steps...
 *   tracker.markValidationPlanned(milestone);
 * }
 * ```
 */
export class MilestoneTracker {
  /**
   * Milestones that have already had validation steps injected.
   * Prevents re-injection after fix steps cause re-completion.
   *
   * Prevents re-injection after fix steps cause re-completion.
   */
  private readonly _sealedMilestones: Set<string>;

  /**
   * @param initialSealed - Pre-sealed milestone names (e.g., loaded from persisted state)
   */
  constructor(initialSealed?: string[]) {
    this._sealedMilestones = new Set(initialSealed ?? []);
  }

  /**
   * Check whether a milestone's implementation steps are all complete.
   * Delegates to the pure `isMilestoneImplementationComplete` function.
   */
  isMilestoneComplete(steps: readonly MilestoneStep[], milestoneName: string): boolean {
    return isMilestoneImplementationComplete(steps, milestoneName);
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
   * 1. The milestone's implementation steps are all complete
   * 2. Validation has NOT already been planned for this milestone
   *
   * Combined guard: checks implementation completeness and sealed state.
   */
  shouldInjectValidation(steps: readonly MilestoneStep[], milestoneName: string): boolean {
    if (this._sealedMilestones.has(milestoneName)) return false;
    return isMilestoneImplementationComplete(steps, milestoneName);
  }

  /**
   * Get all unique milestone names from steps (excluding undefined).
   * Returns in insertion order (first appearance).
   */
  getMilestoneNames(steps: readonly MilestoneStep[]): string[] {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const step of steps) {
      if (step.milestone && !seen.has(step.milestone)) {
        seen.add(step.milestone);
        names.push(step.milestone);
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
   * 1. Implementation complete (all non-validation steps done)
   * 2. Not yet sealed (validation not yet planned)
   *
   * Scans all milestones and returns those ready for validation injection.
   */
  checkCompletedMilestones(steps: readonly MilestoneStep[]): string[] {
    const milestoneNames = this.getMilestoneNames(steps);
    const newlyCompleted: string[] = [];

    for (const name of milestoneNames) {
      if (this.shouldInjectValidation(steps, name)) {
        newlyCompleted.push(name);
      }
    }

    return newlyCompleted;
  }

  /**
   * Create validation steps for a completed milestone and return them
   * in the order they should be injected (scrutiny first, then behavioral).
   *
   * Adapted from multi-agent mission system validation injection patterns:
   * - Scrutiny step: runs test/typecheck/lint + per-step code review
   * - Behavioral validation step: tests assertions from fulfills fields
   *
   * Skip flags control which steps are created:
   * - `skipScrutiny`: omit scrutiny step
   * - `skipValidation`: omit behavioral validation step
   *
   * When both are skipped, returns empty array and still marks milestone sealed.
   *
   * @param milestoneName - The milestone that just completed
   * @param startIndex - Starting 0-based index for the new steps
   * @param options - Skip flags for scrutiny and/or behavioral validation
   * @returns Array of StepInfo objects to prepend to the step queue
   */
  createValidationSteps(
    milestoneName: string,
    startIndex: number,
    options: { skipScrutiny?: boolean; skipValidation?: boolean } = {},
  ): StepInfo[] {
    const { skipScrutiny = false, skipValidation = false } = options;

    if (skipScrutiny && skipValidation) {
      log.info("both validation types skipped for milestone", { milestone: milestoneName });
      return [];
    }

    const steps: StepInfo[] = [];
    let idx = startIndex;

    // Scrutiny validation step (runs first)
    if (!skipScrutiny) {
      steps.push({
        index: idx++,
        title: `Scrutiny: ${milestoneName}`,
        description: [
          `Scrutiny validation for milestone "${milestoneName}".`,
          "Run the project's test suite, typecheck, and lint as hard gates.",
          "Review each completed step in the milestone for code quality, correctness, and test coverage.",
          "Synthesize findings into a scrutiny report.",
        ].join(" "),
        status: "pending",
        steps: [
          "Run test suite",
          "Run typecheck",
          "Run lint",
          "Review completed steps",
          "Synthesize findings",
        ],
        milestone: milestoneName,
      });
    }

    // Behavioral validation step (runs after scrutiny)
    if (!skipValidation) {
      steps.push({
        index: idx++,
        title: `Validation: ${milestoneName}`,
        description: [
          `Behavioral validation for milestone "${milestoneName}".`,
          "Read the validation contract and identify assertions from completed steps' fulfills fields.",
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

    return steps;
  }

  /**
   * Check for milestone completion and create validation steps to inject.
   *
   * This is the main entry point for the execution loop to call after
   * a step completes. It combines milestone detection, skip flag handling,
   * and step creation.
   *
   * Adapted from multi-agent mission system validation injection patterns.
   *
   * @param steps - Current step list (as MilestoneStep projections)
   * @param startIndex - Index at which to start numbering injected steps
   * @param options - Skip flags
   * @returns Object with milestone name and steps to inject, or null if nothing to inject
   */
  checkAndCreateValidationSteps(
    steps: readonly MilestoneStep[],
    startIndex: number,
    options: { skipScrutiny?: boolean; skipValidation?: boolean } = {},
  ): Array<{ milestone: string; steps: StepInfo[] }> {
    const completedMilestones = this.checkCompletedMilestones(steps);
    if (completedMilestones.length === 0) return [];

    const results: Array<{ milestone: string; steps: StepInfo[] }> = [];
    let currentIndex = startIndex;

    for (const milestone of completedMilestones) {
      const validationSteps = this.createValidationSteps(milestone, currentIndex, options);

      // Mark milestone as sealed (even if all steps were skipped)
      this.markValidationPlanned(milestone);

      if (validationSteps.length > 0) {
        results.push({ milestone, steps: validationSteps });
        currentIndex += validationSteps.length;
      }
    }

    return results;
  }
}

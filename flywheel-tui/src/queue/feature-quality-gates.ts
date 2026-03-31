// ---------------------------------------------------------------------------
// Queue System — Feature Quality Gates
// ---------------------------------------------------------------------------
//
// Implements ADR-004 Decision 9: Feature boundary detection and quality
// check step insertion.
//
// When all steps sharing a `feature` field reach terminal status
// (completed/failed/skipped), the hook inserts a single verify-type
// quality check step. After the quality check passes, the feature is
// SEALED — mutations targeting sealed feature steps are rejected.
//
// Terminology:
//   Feature   — named grouping of steps (via step.feature field)
//   Boundary  — the point where all steps in a feature are terminal
//   Sealed    — feature whose quality check has passed; immutable
// ---------------------------------------------------------------------------

import { randomUUID } from "crypto";

import type { Step, Queue, StepStatus } from "./types";
import { insertAfter, type Provenance } from "./queue";
import type { OnStepCompletedResult } from "./hooks";
import { Log } from "../utils/log";

const log = Log.create({ service: "feature-quality-gates" });

// ---------------------------------------------------------------------------
// Terminal status set
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES: ReadonlySet<StepStatus> = new Set([
  "completed",
  "failed",
  "skipped",
]);

// ---------------------------------------------------------------------------
// Quality check step title pattern
// ---------------------------------------------------------------------------

const QUALITY_CHECK_SUFFIX = "feature quality check";

function isQualityCheckStep(step: Step): boolean {
  return step.type === "verify" && step.title.endsWith(QUALITY_CHECK_SUFFIX);
}

// ---------------------------------------------------------------------------
// Feature quality gate state
// ---------------------------------------------------------------------------

export interface FeatureQualityGateState {
  /** Features that have had quality checks inserted (awaiting or done). */
  readonly checkedFeatures: ReadonlySet<string>;
  /** Features whose quality check passed — immutable from here on. */
  readonly sealedFeatures: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Mutation guard result
// ---------------------------------------------------------------------------

export interface MutationGuardResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Feature quality gate hook interface
// ---------------------------------------------------------------------------

export interface FeatureQualityGateHook {
  /** The onStepCompleted hook for the step executor. */
  onStepCompleted: (
    step: Step,
    status: "completed" | "failed",
    queue: Queue,
    handoffData: Record<string, unknown> | null,
  ) => Promise<OnStepCompletedResult>;

  /** Check whether a mutation targeting a step is allowed (sealed guard). */
  guardMutation: (
    mutationType: string,
    targetStepId: string,
    queue: Queue,
  ) => MutationGuardResult;

  /** Get current state for inspection / testing. */
  getState: () => FeatureQualityGateState;
}

// ---------------------------------------------------------------------------
// isFeatureBoundary — pure detection logic
// ---------------------------------------------------------------------------

/**
 * Returns true when ALL steps sharing the given feature field have
 * reached terminal status (completed, failed, or skipped).
 *
 * Returns false if no steps have the given feature, or if any are
 * still pending or running.
 */
export function isFeatureBoundary(steps: Step[], feature: string): boolean {
  const featureSteps = steps.filter((s) => s.feature === feature);
  if (featureSteps.length === 0) return false;
  return featureSteps.every((s) => TERMINAL_STATUSES.has(s.status));
}

// ---------------------------------------------------------------------------
// buildQualityCheckStep — construct the verify step
// ---------------------------------------------------------------------------

/**
 * Builds a single verify-type quality check step for a feature.
 * The step's description contains a prompt instructing the worker to
 * dispatch scrutiny and behavioral testing as parallel sub-agents.
 */
export function buildQualityCheckStep(
  feature: string,
  featureSteps: Step[],
): Step {
  // Collect all fulfills from feature steps (deduplicated)
  const allFulfills = new Set<string>();
  for (const s of featureSteps) {
    if (s.fulfills) {
      for (const f of s.fulfills) {
        allFulfills.add(f);
      }
    }
  }

  // Build step titles list for context
  const stepTitles = featureSteps.map((s) => s.title);

  const description = buildQualityCheckDescription(feature, stepTitles, allFulfills);

  return {
    id: randomUUID(),
    type: "verify",
    title: `[${feature}] ${QUALITY_CHECK_SUFFIX}`,
    status: "pending",
    feature,
    description,
    ...(allFulfills.size > 0 ? { fulfills: [...allFulfills] } : {}),
  };
}

// ---------------------------------------------------------------------------
// Quality check description builder
// ---------------------------------------------------------------------------

function buildQualityCheckDescription(
  feature: string,
  stepTitles: string[],
  fulfills: Set<string>,
): string {
  const lines: string[] = [
    `Feature quality check for "${feature}".`,
    "",
    "Dispatch the following as parallel sub-agents via the Task tool:",
    "",
    "1. **Scrutiny**: Run the full test suite, typecheck, and linter.",
    "   Then dispatch code review sub-agents across all steps in this feature.",
    "   Look for cross-step integration issues, conflicting implementations,",
    "   inconsistent patterns, and regressions.",
    "",
    "2. **Behavioral testing**: Exercise the behavioral contract assertions",
    "   for this feature. Launch the app, test real flows, verify that the",
    "   combined work actually behaves correctly end-to-end.",
    "",
    "Steps in this feature:",
  ];

  for (const title of stepTitles) {
    lines.push(`  - ${title}`);
  }

  if (fulfills.size > 0) {
    lines.push("");
    lines.push("Assertion IDs to verify:");
    for (const id of fulfills) {
      lines.push(`  - ${id}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

function makeProvenance(feature: string): Provenance {
  return {
    actor: "feature-boundary",
    reason: `quality check insertion for feature "${feature}"`,
  };
}

// ---------------------------------------------------------------------------
// findLastFeatureStepIndex — find the last step in a feature
// ---------------------------------------------------------------------------

function findLastFeatureStepIndex(steps: Step[], feature: string): number {
  let lastIdx = -1;
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].feature === feature && !isQualityCheckStep(steps[i])) {
      lastIdx = i;
    }
  }
  return lastIdx;
}

// ---------------------------------------------------------------------------
// createFeatureQualityGateHook — factory function
// ---------------------------------------------------------------------------

/**
 * Creates the feature quality gate hook.
 *
 * On each step completion:
 *   - If the step has a `feature` field, check if ALL steps sharing that
 *     feature are terminal.
 *   - If so (and not already checked), insert a quality check step after
 *     the last step in the feature.
 *   - When a quality check step completes, seal the feature.
 *   - Sealed features reject mutations to their steps.
 */
export function createFeatureQualityGateHook(): FeatureQualityGateHook {
  /** Features that have had quality checks inserted. */
  const checkedFeatures = new Set<string>();
  /** Features whose quality check passed. */
  const sealedFeatures = new Set<string>();

  // -----------------------------------------------------------------------
  // onStepCompleted — the hook
  // -----------------------------------------------------------------------

  async function onStepCompleted(
    step: Step,
    status: "completed" | "failed",
    queue: Queue,
    _handoffData: Record<string, unknown> | null,
  ): Promise<OnStepCompletedResult> {
    // Check if this is a quality check step completing
    if (isQualityCheckStep(step) && step.feature) {
      if (status === "completed") {
        sealedFeatures.add(step.feature);
        log.info("feature sealed after quality check passed", {
          feature: step.feature,
        });
      } else {
        log.warn("feature quality check failed, feature NOT sealed", {
          feature: step.feature,
        });
      }
      return { continueExecution: false };
    }

    // Only consider steps with a non-empty feature field
    const feature = step.feature;
    if (!feature) {
      return { continueExecution: false };
    }

    // Skip if we've already inserted a quality check for this feature
    if (checkedFeatures.has(feature)) {
      return { continueExecution: false };
    }

    // Check if all steps in this feature are terminal
    if (!isFeatureBoundary(queue.steps, feature)) {
      return { continueExecution: false };
    }

    // Feature boundary reached — insert quality check step
    checkedFeatures.add(feature);

    // Gather the feature's steps (exclude any existing quality check)
    const featureSteps = queue.steps.filter(
      (s) => s.feature === feature && !isQualityCheckStep(s),
    );

    const qcStep = buildQualityCheckStep(feature, featureSteps);

    // Find the last step in the feature to insert after
    const lastIdx = findLastFeatureStepIndex(queue.steps, feature);
    if (lastIdx === -1) {
      log.warn("feature boundary reached but no feature steps found", { feature });
      return { continueExecution: false };
    }

    const lastStepId = queue.steps[lastIdx].id;
    const result = insertAfter(queue, lastStepId, [qcStep], makeProvenance(feature));

    if (result.success) {
      log.info("feature quality check inserted", {
        feature,
        stepCount: featureSteps.length,
        qualityCheckId: qcStep.id,
        afterStepId: lastStepId,
      });
    } else {
      log.warn("failed to insert feature quality check", {
        feature,
        error: "error" in result ? result.error : "unknown",
      });
    }

    return { continueExecution: false };
  }

  // -----------------------------------------------------------------------
  // guardMutation — check if a mutation is allowed
  // -----------------------------------------------------------------------

  function guardMutation(
    mutationType: string,
    targetStepId: string,
    queue: Queue,
  ): MutationGuardResult {
    const step = queue.steps.find((s) => s.id === targetStepId);
    if (!step) {
      return { allowed: true };
    }

    const feature = step.feature;
    if (!feature) {
      return { allowed: true };
    }

    if (sealedFeatures.has(feature)) {
      return {
        allowed: false,
        reason: `Cannot ${mutationType} step "${step.title}": feature "${feature}" is sealed after quality check passed`,
      };
    }

    return { allowed: true };
  }

  // -----------------------------------------------------------------------
  // getState — for testing / inspection
  // -----------------------------------------------------------------------

  function getState(): FeatureQualityGateState {
    return {
      checkedFeatures: new Set(checkedFeatures),
      sealedFeatures: new Set(sealedFeatures),
    };
  }

  return {
    onStepCompleted,
    guardMutation,
    getState,
  };
}

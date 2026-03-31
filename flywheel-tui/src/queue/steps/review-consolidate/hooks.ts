// ---------------------------------------------------------------------------
// Queue System — Review Fix Injection Hook
// ---------------------------------------------------------------------------
//
// Dynamically injects a work/fix step after review consolidation completes,
// but ONLY when the review findings warrant it (P1 + P2 > 0).
//
// This replaces the old static "Implement review fixes" step that was
// embedded in the review template. The review step itself now only reviews;
// the dispatcher decides at runtime whether a fix step is needed.
//
// Handoff signal:
//   The consolidation step's handoff includes `finding_counts` with
//   `p1_critical` and `p2_important` fields. When their sum > 0,
//   a work step is injected.
//
// Terminology:
//   Step   — single unit of work
//   Queue  — mutable, ordered list of steps
// ---------------------------------------------------------------------------

import { randomUUID } from "crypto";

import type { Step, Queue } from "../../types";
import { insertAfter, type Provenance } from "../../queue";
import type { OnStepCompletedHook, OnStepCompletedResult } from "../../shared/hooks";
import { Log } from "../../../utils/log";

const log = Log.create({ service: "review-fix-injection" });

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

const REVIEW_FIX_PROVENANCE: Provenance = {
  actor: "review-fix-injection",
  reason: "injecting work/fix step based on review findings",
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Dispatcher hint on the consolidation step that triggers this hook. */
const CONSOLIDATION_HINT = "consolidate-review";

/** Evaluation criteria for the dynamically injected fix step. */
export const REVIEW_FIX_EVALUATION_CRITERIA =
  "All P1 findings addressed, P2 findings addressed or justified as deferred";

// ---------------------------------------------------------------------------
// Finding counts extraction
// ---------------------------------------------------------------------------

interface FindingCounts {
  p1: number;
  p2: number;
  p3: number;
}

/**
 * Extract finding counts from handoff data.
 * Returns null if no finding_counts field is present.
 */
function extractFindingCounts(
  handoffData: Record<string, unknown>,
): FindingCounts | null {
  const fc = handoffData.finding_counts;
  if (!fc || typeof fc !== "object") return null;

  const counts = fc as Record<string, unknown>;
  return {
    p1: typeof counts.p1_critical === "number" ? counts.p1_critical : 0,
    p2: typeof counts.p2_important === "number" ? counts.p2_important : 0,
    p3: typeof counts.p3_suggestion === "number" ? counts.p3_suggestion : 0,
  };
}

// ---------------------------------------------------------------------------
// Build the dynamically injected fix step
// ---------------------------------------------------------------------------

function buildReviewFixStep(
  findingCounts: FindingCounts,
  reviewFilePath?: string,
): Step {
  const descParts: string[] = [
    "Implement fixes identified in the code review.",
    `Findings: ${findingCounts.p1} P1 (critical), ${findingCounts.p2} P2 (important), ${findingCounts.p3} P3 (minor).`,
    "Address P1 findings first, then P2. Skip P3 unless explicitly triaged.",
  ];

  if (reviewFilePath) {
    descParts.push(`Review document: \`${reviewFilePath}\``);
  }

  return {
    id: randomUUID(),
    type: "work",
    title: "Implement review fixes",
    status: "pending",
    description: descParts.join(" "),
    dispatcherHint: "implement-fixes",
    evaluationCriteria: REVIEW_FIX_EVALUATION_CRITERIA,
  };
}

// ---------------------------------------------------------------------------
// createReviewFixInjectionHook — factory function
// ---------------------------------------------------------------------------

/**
 * Creates an `onStepCompleted` hook that watches for the review
 * consolidation step to complete. When it does, the hook reads
 * finding_counts from the handoff data. If P1 + P2 > 0, it inserts
 * a work/fix step immediately after the consolidation step.
 *
 * If P1 + P2 === 0, no step is injected and execution continues
 * to the next planned step (e.g., ship).
 *
 * The hook is idempotent: it tracks whether it has already injected
 * a fix step and will not inject a second one.
 */
export function createReviewFixInjectionHook(): OnStepCompletedHook {
  /** Guard: only inject once per queue execution. */
  let injected = false;

  return async (
    step: Step,
    status: "completed" | "failed",
    queue: Queue,
    handoffData: Record<string, unknown> | null,
  ): Promise<OnStepCompletedResult> => {
    // Only act on completed review consolidation steps
    if (status !== "completed") {
      return { continueExecution: false };
    }

    if (step.type !== "review") {
      return { continueExecution: false };
    }

    if (step.dispatcherHint !== CONSOLIDATION_HINT) {
      return { continueExecution: false };
    }

    // Guard: already injected
    if (injected) {
      log.info("review fix step already injected, skipping", {
        stepId: step.id,
      });
      return { continueExecution: false };
    }

    // No handoff data — cannot determine findings
    if (!handoffData) {
      log.info("no handoff data from consolidation step, skipping fix injection", {
        stepId: step.id,
      });
      return { continueExecution: false };
    }

    // Extract finding counts
    const findingCounts = extractFindingCounts(handoffData);
    if (!findingCounts) {
      log.info("no finding_counts in consolidation handoff, skipping fix injection", {
        stepId: step.id,
      });
      return { continueExecution: false };
    }

    const actionableCount = findingCounts.p1 + findingCounts.p2;

    if (actionableCount === 0) {
      log.info("no actionable findings (P1+P2=0), skipping fix injection", {
        stepId: step.id,
        findingCounts,
      });
      return { continueExecution: false };
    }

    // Build and inject the fix step
    injected = true;

    const reviewFilePath = typeof handoffData.review_file_path === "string"
      ? handoffData.review_file_path
      : undefined;

    const fixStep = buildReviewFixStep(findingCounts, reviewFilePath);

    const result = insertAfter(queue, step.id, [fixStep], REVIEW_FIX_PROVENANCE);

    if (result.success) {
      log.info("review fix step injected", {
        stepId: step.id,
        fixStepId: fixStep.id,
        findingCounts,
        reviewFilePath,
      });
    } else {
      log.warn("failed to inject review fix step", {
        stepId: step.id,
        error: "error" in result ? result.error : "unknown",
      });
      // Reset guard so it can retry if queue is re-executed
      injected = false;
    }

    return { continueExecution: false };
  };
}

// ---------------------------------------------------------------------------
// Queue System — Plan Integration
// ---------------------------------------------------------------------------
//
// Handles deferred work-step insertion: when a plan step completes and
// produces proto-steps JSON, this module formalizes them via
// formalizeProtoSteps() and inserts the resulting work steps into the
// queue at the correct position (before review/ship steps).
//
// Placement: src/queue/plan-integration.ts
//
// Terminology:
//   ProtoStep — lightweight step definition from plan output
//   Step      — full queue step with ID, type, status, and metadata
//   Queue     — mutable, ordered list of steps
// ---------------------------------------------------------------------------

import type { Step, Queue } from "./types";
import type { ProtoStep } from "./proto-step";
import { formalizeProtoSteps } from "./proto-step";
import { insertAfter, type MutationResult, type Provenance } from "./queue";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Provenance for plan integration mutations
// ---------------------------------------------------------------------------

const PLAN_INTEGRATION_PROVENANCE: Provenance = {
  actor: "plan-integration",
  reason: "inserting work steps from plan output",
};

// ---------------------------------------------------------------------------
// findInsertionPoint — determine where to insert work steps
// ---------------------------------------------------------------------------

/**
 * Finds the correct insertion index for work steps after a completed plan
 * step. Work steps should be inserted:
 *   - After the plan step
 *   - Before the first review/ship/gate step that follows the plan
 *
 * This ensures work steps appear between plan and review/ship in templates
 * like plan-work-review and full.
 *
 * @param steps The current queue steps array
 * @param planStepId The ID of the completed plan step
 * @returns The index at which to insert work steps, or -1 if plan step not found
 */
export function findInsertionPoint(steps: Step[], planStepId: string): number {
  const planIdx = steps.findIndex((s) => s.id === planStepId);
  if (planIdx === -1) return -1;

  // Look for the first review, ship, or gate step after the plan step
  for (let i = planIdx + 1; i < steps.length; i++) {
    const step = steps[i];
    if (step.type === "review" || step.type === "ship" || step.type === "gate") {
      return i;
    }
  }

  // No review/ship/gate found — insert at the end (after plan)
  return planIdx + 1;
}

// ---------------------------------------------------------------------------
// insertWorkStepsFromPlanOutput — main integration function
// ---------------------------------------------------------------------------

/**
 * When a plan step completes and produces proto-steps, this function:
 *   1. Validates the proto-steps array is non-empty
 *   2. Formalizes proto-steps into full Step[] via formalizeProtoSteps()
 *   3. Determines the correct insertion point in the queue
 *   4. Inserts the work steps using the queue mutation API
 *
 * @param queue The current queue
 * @param planStepId The ID of the completed plan step
 * @param protoSteps The proto-steps produced by the plan
 * @returns MutationResult indicating success or failure
 */
export function insertWorkStepsFromPlanOutput(
  queue: Queue,
  planStepId: string,
  protoSteps: ProtoStep[],
): MutationResult {
  // Validate non-empty
  if (protoSteps.length === 0) {
    return {
      success: false,
      error: "Cannot insert work steps: proto-steps array is empty",
    };
  }

  // Check plan step exists
  const planIdx = queue.steps.findIndex((s) => s.id === planStepId);
  if (planIdx === -1) {
    return {
      success: false,
      error: `Plan step not found: ${planStepId}`,
    };
  }

  // Formalize proto-steps into full Steps with unique IDs
  const formalizedSteps = formalizeProtoSteps(protoSteps, {
    stepType: "work",
    idGenerator: () => randomUUID(),
  });

  // Convert StepWithPrompt[] to Step[] (drop the prompt field for queue insertion)
  const workSteps: Step[] = formalizedSteps.map((s) => ({
    id: s.id,
    type: s.type,
    title: s.title,
    status: s.status,
    ...(s.milestone ? { milestone: s.milestone } : {}),
    ...(s.fulfills && s.fulfills.length > 0 ? { fulfills: s.fulfills } : {}),
  }));

  // Find the step to insert after
  // We need the ID of the step just before the insertion point
  const insertionIdx = findInsertionPoint(queue.steps, planStepId);

  // Determine the step ID to insert after
  // If insertion point is right after plan, use planStepId
  // If insertion point is at a later position, use the step before that position
  const insertAfterId =
    insertionIdx <= planIdx + 1
      ? planStepId
      : queue.steps[insertionIdx - 1].id;

  return insertAfter(queue, insertAfterId, workSteps, PLAN_INTEGRATION_PROVENANCE);
}

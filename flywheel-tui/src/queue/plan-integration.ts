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
import { ProtoStepArraySchema, formalizeProtoSteps } from "./proto-step";
import { insertAfter, type MutationResult, type Provenance } from "./queue";
import type { OnStepCompletedHook, OnStepCompletedResult } from "./executor";
import { randomUUID } from "crypto";
import { Log } from "../utils/log";

const log = Log.create({ service: "plan-integration" });

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
  // Carry all plan metadata: description, acceptanceCriteria, fileReferences,
  // feature, fulfills, milestone
  const workSteps: Step[] = formalizedSteps.map((s) => ({
    id: s.id,
    type: s.type,
    title: s.title,
    status: s.status,
    ...(s.description ? { description: s.description } : {}),
    ...(s.acceptanceCriteria && s.acceptanceCriteria.length > 0
      ? { acceptanceCriteria: s.acceptanceCriteria }
      : {}),
    ...(s.fileReferences && s.fileReferences.length > 0
      ? { fileReferences: s.fileReferences }
      : {}),
    ...(s.feature ? { feature: s.feature } : {}),
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

// ---------------------------------------------------------------------------
// createPlanIntegrationHook — onStepCompleted hook for plan output insertion
// ---------------------------------------------------------------------------

/**
 * Creates an `onStepCompleted` hook that detects when a plan consolidation
 * step completes and inserts formalized work steps into the queue.
 *
 * The hook checks if the completed step is a plan step and if the handoff
 * data contains a `steps` array (proto-steps from plan output). If so,
 * it validates the proto-steps and calls `insertWorkStepsFromPlanOutput()`.
 *
 * @returns An OnStepCompletedHook suitable for passing to StepExecutorOptions
 */
export function createPlanIntegrationHook(): OnStepCompletedHook {
  return async (
    step: Step,
    status: "completed" | "failed",
    queue: Queue,
    handoffData: Record<string, unknown> | null,
  ): Promise<OnStepCompletedResult> => {
    // Only act on completed plan steps with handoff data containing steps[]
    if (status !== "completed" || step.type !== "plan") {
      return { continueExecution: false };
    }

    if (!handoffData || !Array.isArray(handoffData.steps) || handoffData.steps.length === 0) {
      return { continueExecution: false };
    }

    // Validate proto-steps using Zod schema
    const parseResult = ProtoStepArraySchema.safeParse(handoffData.steps);
    if (!parseResult.success) {
      log.warn("plan integration: invalid proto-steps in handoff", {
        stepId: step.id,
        error: parseResult.error.message,
      });
      return { continueExecution: false };
    }

    const protoSteps = parseResult.data;
    const result = insertWorkStepsFromPlanOutput(queue, step.id, protoSteps);

    if (result.success) {
      log.info("plan integration: inserted work steps from plan output", {
        stepId: step.id,
        count: protoSteps.length,
      });
    } else {
      log.warn("plan integration: failed to insert work steps", {
        stepId: step.id,
        error: "error" in result ? result.error : "unknown",
      });
    }

    return { continueExecution: false };
  };
}

// ---------------------------------------------------------------------------
// createCompositeHook — chains multiple onStepCompleted hooks
// ---------------------------------------------------------------------------

/**
 * Creates a composite hook that chains multiple `onStepCompleted` hooks.
 * Hooks are called in order. If any hook returns `{ continueExecution: true }`,
 * the composite returns `{ continueExecution: true }`.
 *
 * This allows combining plan-integration, sprint, and other hooks into
 * a single hook for the step executor.
 *
 * @param hooks Array of hooks to chain (null/undefined entries are skipped)
 * @returns A single OnStepCompletedHook that chains all provided hooks
 */
export function createCompositeHook(
  hooks: Array<OnStepCompletedHook | null | undefined>,
): OnStepCompletedHook {
  const activeHooks = hooks.filter(
    (h): h is OnStepCompletedHook => h != null,
  );

  return async (
    step: Step,
    status: "completed" | "failed",
    queue: Queue,
    handoffData: Record<string, unknown> | null,
  ): Promise<OnStepCompletedResult> => {
    let shouldContinue = false;

    for (const hook of activeHooks) {
      const result = await hook(step, status, queue, handoffData);
      if (result.continueExecution) {
        shouldContinue = true;
      }
    }

    return { continueExecution: shouldContinue };
  };
}

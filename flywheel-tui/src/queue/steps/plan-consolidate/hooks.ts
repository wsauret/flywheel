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

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Step, Queue } from "../../types";
import type { ProtoStep } from "./proto-step";
import { ProtoStepArraySchema, formalizeProtoSteps } from "./proto-step";
import { insertAfter, type MutationResult, type Provenance } from "../../queue";
import type { OnStepCompletedHook, OnStepCompletedResult } from "../../shared/hooks";
import { parseJsonPlan } from "../../shared/plan-parser";
import type { PlanImportResult } from "../../shared/plan-import";
import { resolveSessionFile } from "../../../config/paths";
import { randomUUID } from "crypto";
import { Log } from "../../../utils/log";

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

  // Look for the first review or ship step after the plan step.
  // Gate steps are skipped — work steps should be inserted AFTER gates
  // (e.g., plan → gate → [WORK STEPS] → review).
  for (let i = planIdx + 1; i < steps.length; i++) {
    const step = steps[i];
    if (step.type === "review" || step.type === "ship") {
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
// Confirmation callback type
// ---------------------------------------------------------------------------

/**
 * Optional callback for interactive plan confirmation (HITL).
 * When provided, the hook calls this before inserting work steps.
 * The callback receives the parsed plan data and returns true (approved)
 * or false (rejected). When rejected, work steps are NOT inserted.
 */
export type ConfirmBeforeInsert = (planResult: PlanImportResult) => Promise<boolean>;

// ---------------------------------------------------------------------------
// buildPlanImportResult — converts parsed plan data to PlanImportResult
// ---------------------------------------------------------------------------

/**
 * Converts parsed plan JSON or proto-steps into a PlanImportResult for
 * use by the plan confirmation UI.
 */
function buildPlanImportResult(
  source:
    | { kind: "json"; plan: import("../../shared/plan-parser").PlanJson }
    | { kind: "proto"; protoSteps: ProtoStep[] },
): PlanImportResult {
  if (source.kind === "json") {
    const plan = source.plan;
    const totalCriteria = plan.steps.reduce(
      (acc, s) => acc + s.acceptanceCriteria.length,
      0,
    );
    return {
      status: "ready",
      steps: plan.steps.map((s) => ({
        title: s.title,
        description: s.description,
        acceptanceCriteria: s.acceptanceCriteria,
        ...(s.fileReferences ? { fileReferences: s.fileReferences } : {}),
        ...(s.feature ? { feature: s.feature } : {}),
        ...(s.fulfills ? { fulfills: s.fulfills } : {}),
        ...(s.milestone ? { milestone: s.milestone } : {}),
        ...(s.estimatedComplexity ? { estimatedComplexity: s.estimatedComplexity } : {}),
      })),
      behavioralContract: plan.behavioralContract,
      decisions: plan.decisions,
      risks: plan.risks,
      issues: [],
      summary: {
        stepCount: plan.steps.length,
        totalSteps: totalCriteria,
        hasAcceptanceCriteria: plan.steps.every(
          (s) => s.acceptanceCriteria.length > 0,
        ),
        contentHash: "",
      },
      isJsonPlan: true,
    };
  }

  // Proto-steps source (from handoff data)
  const steps = source.protoSteps;
  const totalCriteria = steps.reduce(
    (acc, s) => acc + s.acceptanceCriteria.length,
    0,
  );
  return {
    status: "ready",
    steps: steps.map((s) => ({
      title: s.title,
      description: s.description,
      acceptanceCriteria: s.acceptanceCriteria,
      ...(s.fileReferences ? { fileReferences: s.fileReferences } : {}),
      ...(s.feature ? { feature: s.feature } : {}),
      ...(s.fulfills ? { fulfills: s.fulfills } : {}),
      ...(s.milestone ? { milestone: s.milestone } : {}),
      ...(s.estimatedComplexity ? { estimatedComplexity: s.estimatedComplexity } : {}),
    })),
    behavioralContract: [],
    decisions: [],
    risks: [],
    issues: [],
    summary: {
      stepCount: steps.length,
      totalSteps: totalCriteria,
      hasAcceptanceCriteria: steps.every(
        (s) => s.acceptanceCriteria.length > 0,
      ),
      contentHash: "",
    },
    isJsonPlan: true,
  };
}

// ---------------------------------------------------------------------------
// createPlanIntegrationHook — onStepCompleted hook for plan output insertion
// ---------------------------------------------------------------------------

/**
 * Creates an `onStepCompleted` hook that detects when a plan consolidation
 * step completes and inserts formalized work steps into the queue.
 *
 * The hook tries two sources for plan steps:
 *   1. handoffData.steps — direct proto-steps array in the handoff JSON
 *   2. handoffData.plan_file_path — path to a .plan.json file on disk
 *
 * If neither source yields valid steps, the hook returns silently.
 *
 * @param projectCwd The project root directory (for resolving relative plan paths)
 * @param sessionId Optional session ID for fallback path resolution via centralized paths
 * @param confirmBeforeInsert Optional callback for interactive plan confirmation (HITL).
 *   When provided, the hook calls this before inserting work steps.
 *   Returns true to approve (insert steps) or false to reject (skip insertion).
 * @returns An OnStepCompletedHook suitable for passing to StepExecutorOptions
 */
export function createPlanIntegrationHook(
  projectCwd?: string,
  sessionId?: string,
  confirmBeforeInsert?: ConfirmBeforeInsert,
): OnStepCompletedHook {
  return async (
    step: Step,
    status: "completed" | "failed",
    queue: Queue,
    handoffData: Record<string, unknown> | null,
  ): Promise<OnStepCompletedResult> => {
    // Only act on completed plan steps
    if (status !== "completed" || step.type !== "plan") {
      return { continueExecution: false };
    }

    if (!handoffData) {
      return { continueExecution: false };
    }

    // --- Source 1: handoffData.steps (direct proto-steps array) ---
    if (Array.isArray(handoffData.steps) && handoffData.steps.length > 0) {
      const parseResult = ProtoStepArraySchema.safeParse(handoffData.steps);
      if (parseResult.success) {
        const protoSteps = parseResult.data;

        // Interactive confirmation gate (HITL)
        if (confirmBeforeInsert) {
          const planResult = buildPlanImportResult({ kind: "proto", protoSteps });
          const approved = await confirmBeforeInsert(planResult);
          if (!approved) {
            log.info("plan integration: user rejected plan from handoff steps", {
              stepId: step.id,
              count: protoSteps.length,
            });
            return { continueExecution: false };
          }
        }

        const result = insertWorkStepsFromPlanOutput(queue, step.id, protoSteps);

        if (result.success) {
          log.info("plan integration: inserted work steps from handoff steps", {
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
      }

      log.warn("plan integration: invalid proto-steps in handoff", {
        stepId: step.id,
        error: parseResult.error.message,
      });
      // Fall through to try plan_file_path
    }

    // --- Source 2: handoffData.plan_file_path (read .plan.json from disk) ---
    // Only read plan file for consolidation steps to avoid premature insertion
    // (draft/review steps may also produce plan_file_path but their output
    // is intermediate — only the consolidated plan should trigger work insertion).
    const isConsolidation = step.dispatcherHint === "consolidate"
      || step.title?.toLowerCase().includes("consolidat");
    if (isConsolidation && typeof handoffData.plan_file_path === "string" && handoffData.plan_file_path.length > 0) {
      // Resolve plan file path via centralized session paths when available,
      // otherwise fall back to the raw path from handoff data.
      const planFilePath = (sessionId && projectCwd)
        ? resolveSessionFile(sessionId, "plan", projectCwd)
        : path.isAbsolute(handoffData.plan_file_path)
          ? handoffData.plan_file_path
          : projectCwd
            ? path.join(projectCwd, handoffData.plan_file_path)
            : handoffData.plan_file_path;

      try {
        const content = await fs.readFile(planFilePath, "utf-8");
        const jsonParseResult = parseJsonPlan(content);

        if (!jsonParseResult.ok) {
          log.warn("plan integration: failed to parse plan file", {
            stepId: step.id,
            planFilePath,
            error: jsonParseResult.error,
          });
          return { continueExecution: false };
        }

        // Interactive confirmation gate (HITL)
        if (confirmBeforeInsert) {
          const planResult = buildPlanImportResult({ kind: "json", plan: jsonParseResult.plan });
          const approved = await confirmBeforeInsert(planResult);
          if (!approved) {
            log.info("plan integration: user rejected plan from plan file", {
              stepId: step.id,
              planFilePath,
            });
            return { continueExecution: false };
          }
        }

        // Convert PlanStep[] to ProtoStep[] (compatible schemas)
        const protoSteps: ProtoStep[] = jsonParseResult.plan.steps.map((s) => ({
          title: s.title,
          description: s.description,
          acceptanceCriteria: s.acceptanceCriteria,
          ...(s.fileReferences ? { fileReferences: s.fileReferences } : {}),
          ...(s.feature ? { feature: s.feature } : {}),
          ...(s.milestone ? { milestone: s.milestone } : {}),
          ...(s.fulfills ? { fulfills: s.fulfills } : {}),
          ...(s.estimatedComplexity ? { estimatedComplexity: s.estimatedComplexity } : {}),
        }));

        const result = insertWorkStepsFromPlanOutput(queue, step.id, protoSteps);

        if (result.success) {
          log.info("plan integration: inserted work steps from plan file", {
            stepId: step.id,
            planFilePath,
            count: protoSteps.length,
          });
        } else {
          log.warn("plan integration: failed to insert work steps from plan file", {
            stepId: step.id,
            planFilePath,
            error: "error" in result ? result.error : "unknown",
          });
        }
        return { continueExecution: false };
      } catch (err) {
        log.warn("plan integration: unexpected error processing plan file", {
          stepId: step.id,
          planFilePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { continueExecution: false };
  };
}


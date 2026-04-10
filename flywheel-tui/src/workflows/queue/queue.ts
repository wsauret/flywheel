// ---------------------------------------------------------------------------
// Queue System — Factory & Mutation API
// ---------------------------------------------------------------------------
//
// Core queue data model: creation, step lifecycle transitions, and mutation
// operations (insert, remove, skip, reorder, replace). All mutations record
// provenance in the mutation log and enforce validation rules.
//
// Terminology:
//   Step   — single unit of work (replaces "step")
//   Queue  — mutable, ordered list of steps for a session
// ---------------------------------------------------------------------------

import type {
  Step,
  StepStatus,
  Queue,
  MutationLogEntry,
} from "./types";

// ---------------------------------------------------------------------------
// Provenance — who triggered the mutation and why
// ---------------------------------------------------------------------------

export interface Provenance {
  /** Who triggered the mutation (executor, user, sprint-hook, etc.). */
  readonly actor: string;
  /** Why the mutation was performed. */
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// MutationResult — discriminated union for mutation outcomes
// ---------------------------------------------------------------------------

export type MutationResult =
  | { success: true; queue: Queue }
  | { success: false; error: string };

// ---------------------------------------------------------------------------
// Queue options
// ---------------------------------------------------------------------------

export interface QueueOptions {
  /** Maximum number of steps allowed. Inserts exceeding this are rejected. */
  maxSteps?: number;
}

// ---------------------------------------------------------------------------
// Valid step transitions
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<StepStatus, StepStatus[]> = {
  pending: ["running", "skipped"],
  running: ["completed", "failed", "pending"],
  completed: [],
  failed: ["pending"],
  skipped: [],
};

// ---------------------------------------------------------------------------
// createQueue — factory function
// ---------------------------------------------------------------------------

/**
 * Creates a new Queue from an array of steps.
 * All steps are set to pending, cursor starts at 0.
 */
export function createQueue(
  steps: Step[],
  opts?: QueueOptions,
): Queue {
  const queue: Queue = {
    steps: steps.map((s) => ({ ...s, status: "pending" as const })),
    cursor: 0,
    status: "idle",
    mutationLog: [],
  };
  if (opts?.maxSteps !== undefined) {
    queue.maxSteps = opts.maxSteps;
  }
  return queue;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function logMutation(
  queue: Queue,
  action: string,
  stepIds: string[],
  provenance: Provenance,
): void {
  const entry = {
    timestamp: Date.now(),
    action,
    actor: provenance.actor,
    reason: provenance.reason,
    stepIds,
  };
  queue.mutationLog.push(entry);
}

function findStep(queue: Queue, stepId: string): Step | undefined {
  return queue.steps.find((s) => s.id === stepId);
}

function findStepIndex(queue: Queue, stepId: string): number {
  return queue.steps.findIndex((s) => s.id === stepId);
}

// ---------------------------------------------------------------------------
// transitionStep — enforce valid lifecycle transitions
// ---------------------------------------------------------------------------

/**
 * Transition a step to a new status. Enforces valid transitions:
 *   pending → running | skipped
 *   running → completed | failed | pending (abort/interrupt recovery)
 *   failed  → pending (resume retry)
 *   completed, skipped → (none — terminal)
 */
export function transitionStep(
  queue: Queue,
  stepId: string,
  newStatus: StepStatus,
  provenance: Provenance,
): MutationResult {
  const step = findStep(queue, stepId);
  if (!step) {
    return { success: false, error: `Step not found: ${stepId}` };
  }

  const allowed = VALID_TRANSITIONS[step.status];
  if (!allowed.includes(newStatus)) {
    return {
      success: false,
      error: `Invalid transition: ${step.status} → ${newStatus} for step ${stepId}`,
    };
  }

  step.status = newStatus;
  logMutation(queue, "status-change", [stepId], provenance);
  return { success: true, queue };
}

// ---------------------------------------------------------------------------
// advanceCursor — move cursor to next pending step
// ---------------------------------------------------------------------------

/**
 * Advances the queue cursor to the next pending step, skipping
 * completed/failed/skipped steps. If no pending steps remain,
 * cursor moves past the end of the array.
 */
export function advanceCursor(queue: Queue): void {
  let idx = queue.cursor;
  while (idx < queue.steps.length) {
    if (queue.steps[idx].status === "pending") {
      queue.cursor = idx;
      return;
    }
    idx++;
  }
  // No pending steps found — cursor past end
  queue.cursor = queue.steps.length;
}

// ---------------------------------------------------------------------------
// isFinished — check if queue has no pending/running steps
// ---------------------------------------------------------------------------

/**
 * Returns true when no steps have status "pending" or "running".
 */
export function isFinished(queue: Queue): boolean {
  return !queue.steps.some(
    (s) => s.status === "pending" || s.status === "running",
  );
}

// ---------------------------------------------------------------------------
// insertAfter — insert step(s) after a specific step ID
// ---------------------------------------------------------------------------

/**
 * Inserts one or more steps after the step with the given ID.
 * Respects max_steps if set. All inserted steps must be pending.
 */
export function insertAfter(
  queue: Queue,
  afterStepId: string,
  newSteps: Step[],
  provenance: Provenance,
): MutationResult {
  const idx = findStepIndex(queue, afterStepId);
  if (idx === -1) {
    return { success: false, error: `Step not found: ${afterStepId}` };
  }

  const maxSteps = queue.maxSteps;
  if (
    maxSteps !== undefined &&
    queue.steps.length + newSteps.length > maxSteps
  ) {
    return {
      success: false,
      error: `Cannot insert ${newSteps.length} step(s): would exceed max_steps (${maxSteps}). Current: ${queue.steps.length}`,
    };
  }

  // Insert after the target index
  const insertionIndex = idx + 1;
  queue.steps.splice(insertionIndex, 0, ...newSteps);

  // Adjust cursor when inserting steps before current cursor position
  // (similar to how removeStep already adjusts cursor)
  if (insertionIndex <= queue.cursor) {
    queue.cursor += newSteps.length;
  }

  logMutation(
    queue,
    "insert",
    newSteps.map((s) => s.id),
    provenance,
  );
  return { success: true, queue };
}

// ---------------------------------------------------------------------------
// removeStep — remove a pending step by ID
// ---------------------------------------------------------------------------

/**
 * Removes a step from the queue. Only pending and skipped steps can be removed.
 * Completed and running steps are protected.
 */
export function removeStep(
  queue: Queue,
  stepId: string,
  provenance: Provenance,
): MutationResult {
  const idx = findStepIndex(queue, stepId);
  if (idx === -1) {
    return { success: false, error: `Step not found: ${stepId}` };
  }

  const step = queue.steps[idx];
  if (step.status === "completed" || step.status === "running") {
    return {
      success: false,
      error: `Cannot remove ${step.status} step: ${stepId}`,
    };
  }

  queue.steps.splice(idx, 1);

  // Adjust cursor if removed step was before or at cursor
  if (idx < queue.cursor) {
    queue.cursor = Math.max(0, queue.cursor - 1);
  }

  logMutation(queue, "remove", [stepId], provenance);
  return { success: true, queue };
}

// ---------------------------------------------------------------------------
// skipStep — mark a pending step as skipped
// ---------------------------------------------------------------------------

/**
 * Marks a pending step as skipped. Completed and running steps cannot
 * be skipped. After skipping, cursor is advanced past the skipped step
 * if it was at the cursor position.
 */
export function skipStep(
  queue: Queue,
  stepId: string,
  provenance: Provenance,
): MutationResult {
  const step = findStep(queue, stepId);
  if (!step) {
    return { success: false, error: `Step not found: ${stepId}` };
  }

  if (step.status !== "pending") {
    return {
      success: false,
      error: `Cannot skip ${step.status} step: ${stepId}`,
    };
  }

  step.status = "skipped";
  logMutation(queue, "skip", [stepId], provenance);

  // Advance cursor past skipped step if needed
  advanceCursor(queue);

  return { success: true, queue };
}


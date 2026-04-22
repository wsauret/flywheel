import type {
  Step,
  StepStatus,
  Queue,
  MutationLogEntry,
} from "./types.js";

export interface Provenance {
  readonly actor: string;
  readonly reason: string;
}

type MutationResult =
  | { success: true; queue: Queue }
  | { success: false; error: string };

export interface QueueOptions {
  maxSteps?: number;
}

const VALID_TRANSITIONS: Record<StepStatus, StepStatus[]> = {
  pending: ["running", "skipped"],
  running: ["completed", "failed", "pending"],
  completed: [],
  failed: ["pending"],
  skipped: [],
};

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

function logMutation(
  queue: Queue,
  action: string,
  stepIds: string[],
  provenance: Provenance,
) {
  const entry = {
    timestamp: Date.now(),
    action,
    actor: provenance.actor,
    reason: provenance.reason,
    stepIds,
  };
  queue.mutationLog.push(entry);
}

function findStep(queue: Queue, stepId: string) {
  return queue.steps.find((s) => s.id === stepId);
}

function findStepIndex(queue: Queue, stepId: string) {
  return queue.steps.findIndex((s) => s.id === stepId);
}

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

export function advanceCursor(queue: Queue): void {
  let idx = queue.cursor;
  while (idx < queue.steps.length) {
    if (queue.steps[idx].status === "pending") {
      queue.cursor = idx;
      return;
    }
    idx++;
  }
  queue.cursor = queue.steps.length;
}

export function isFinished(queue: Queue): boolean {
  return !queue.steps.some(
    (s) => s.status === "pending" || s.status === "running",
  );
}

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

  const insertionIndex = idx + 1;
  queue.steps.splice(insertionIndex, 0, ...newSteps);

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

  if (idx < queue.cursor) {
    queue.cursor = Math.max(0, queue.cursor - 1);
  }

  logMutation(queue, "remove", [stepId], provenance);
  return { success: true, queue };
}

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

  advanceCursor(queue);

  return { success: true, queue };
}


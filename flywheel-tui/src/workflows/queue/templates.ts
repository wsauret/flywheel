// ---------------------------------------------------------------------------
// Queue System — Workflow Templates
// ---------------------------------------------------------------------------

import { randomUUID } from "crypto";
import { createQueue, type QueueOptions } from "./queue";
import type { Step, Queue } from "./types";
import type { StepType } from "../../infra/step-types";
import { SPRINT_HINT } from "./steps/sprint/types.js";
import { buildSprintEvaluationCriteria } from "./steps/sprint/evaluator-criteria.js";

// ---------------------------------------------------------------------------
// WorkflowName — supported workflow template names
// ---------------------------------------------------------------------------

export type WorkflowName = "work" | "sprint";

// ---------------------------------------------------------------------------
// Step factory helper
// ---------------------------------------------------------------------------

export function makeStep(type: StepType, title: string, extra?: Partial<Step>): Step {
  return {
    id: randomUUID(),
    type,
    title,
    status: "pending",
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Build a Queue from a workflow template name. */
export function buildQueueFromTemplate(
  name: WorkflowName,
  maxSteps?: number,
): Queue {
  const queueOpts: QueueOptions | undefined = maxSteps
    ? { maxSteps }
    : undefined;

  switch (name) {
    case "work": {
      const steps: Step[] = [
        makeStep("work", "Execute work", {
          toolScoping: { read: true, bash: true, write: true, edit: true, task: true },
        }),
      ];
      return createQueue(steps, queueOpts);
    }

    case "sprint": {
      const steps: Step[] = [
        makeStep("work", "Execute sprint", {
          dispatcherHint: SPRINT_HINT,
          toolScoping: { read: true, bash: true, write: true, edit: true, task: true },
          evaluationCriteria: buildSprintEvaluationCriteria(),
        }),
      ];
      return createQueue(steps, queueOpts);
    }

    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown workflow template: ${_exhaustive}`);
    }
  }
}

// Queue System — Workflow Templates

import { randomUUID } from "crypto";
import { createQueue, type QueueOptions } from "./queue.js";
import type { Step, Queue } from "./types.js";
import { SPRINT_HINT } from "./steps/sprint/types.js";
import { buildSprintEvaluationCriteria } from "./steps/sprint/evaluator-criteria.js";

export type WorkflowName = "work" | "sprint" | "plan";

export function makeStep(type: Step["type"], title: string, extra?: Partial<Step>): Step {
  return {
    id: randomUUID(),
    type,
    title,
    status: "pending",
    ...extra,
  };
}

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

    case "plan": {
      const steps: Step[] = [
        makeStep("plan", "Create implementation plan", {
          toolScoping: { read: true, bash: true, write: true, edit: true, task: true },
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

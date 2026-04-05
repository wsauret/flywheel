// ---------------------------------------------------------------------------
// Queue System — Workflow Templates (simplified: work only)
// ---------------------------------------------------------------------------

import { randomUUID } from "crypto";
import { createQueue, type QueueOptions } from "./queue";
import type { Step, Queue, StepType, WorkflowTemplate } from "./types";

// ---------------------------------------------------------------------------
// WorkflowName — only "work" is supported
// ---------------------------------------------------------------------------

export type WorkflowName = "work";

// ---------------------------------------------------------------------------
// BuildQueueOptions — configuration for queue building
// ---------------------------------------------------------------------------

interface BuildQueueOptions {
  /** When false, gate steps are inserted between major transitions. Default: true (no gates). */
  skipApprovalGates?: boolean;
  /** Maximum number of steps in the queue. */
  maxSteps?: number;
}

// ---------------------------------------------------------------------------
// Step factory helper
// ---------------------------------------------------------------------------

function makeStep(type: StepType, title: string, extra?: Partial<Step>): Step {
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

/**
 * Build a Queue from a workflow template name.
 *
 * @param name The workflow template name
 * @param options Optional configuration (gates, max steps)
 * @returns A new Queue with the initial steps for the template
 */
export function buildQueueFromTemplate(
  name: WorkflowName,
  options?: BuildQueueOptions,
): Queue {
  if (name !== "work") {
    throw new Error(`Unknown workflow template: ${name}`);
  }

  const steps: Step[] = [
    makeStep("work", "Execute work", {
      toolScoping: { read: true, bash: true, write: true, edit: true, task: true },
    }),
  ];

  const queueOpts: QueueOptions | undefined = options?.maxSteps
    ? { maxSteps: options.maxSteps }
    : undefined;

  return createQueue(steps, queueOpts);
}

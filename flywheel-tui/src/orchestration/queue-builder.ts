/**
 * Queue Builder — creates a Queue from a slash command name + config.
 */

import {
  buildQueueFromTemplate,
  type WorkflowName,
} from "../workflows/queue/templates";
import type { Queue } from "../workflows/queue/types";
import type { FlywheelConfig } from "./config/schema";

const templateMap: Record<string, WorkflowName> = {
  work: "work",
  sprint: "sprint",
};

/** Map a slash command to a workflow template and build the queue. */
export function buildQueueForSlashCommand(command: string, config: FlywheelConfig): Queue {
  const workflowName: WorkflowName = templateMap[command] ?? "work";
  return buildQueueFromTemplate(workflowName, {
    skipApprovalGates: config.skip_approval_gates,
    maxSteps: config.queue?.max_steps,
  });
}


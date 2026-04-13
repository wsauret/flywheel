/**
 * Queue Builder — creates a Queue from a slash command name + config.
 */

import {
  buildQueueFromTemplate,
  type WorkflowName,
} from "../workflows/queue/templates";
import type { Queue } from "../workflows/queue/types";
import type { FlywheelConfig } from "./config/schema";

/** Map a slash command to a workflow template and build the queue. */
export function buildQueueForSlashCommand(command: string, config: FlywheelConfig): Queue {
  const workflowName: WorkflowName = command === "sprint" ? "sprint" : "work";
  return buildQueueFromTemplate(workflowName, config.queue?.max_steps);
}


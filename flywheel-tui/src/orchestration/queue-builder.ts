/**
 * Queue Builder — queue-based workflow composition.
 *
 * Contains:
 *   - `buildQueue` — pure function to create a Queue from a WorkflowName + config
 *   - `buildQueueForSlashCommand` — creates queue from slash command name + config
 */

import {
  buildQueueFromTemplate,
  type WorkflowName,
} from "../workflows/queue/templates";
import type { Queue } from "../workflows/queue/types";
import type { FlywheelConfig } from "./config/schema";

// ---------------------------------------------------------------------------
// buildQueue — create a Queue from a workflow template name + config
// ---------------------------------------------------------------------------

/**
 * Build a Queue from a workflow template name and config.
 *
 * @param workflowName The workflow template name
 * @param config FlywheelConfig
 * @returns A new Queue
 */
function buildQueue(workflowName: WorkflowName, config: FlywheelConfig): Queue {
  return buildQueueFromTemplate(workflowName, {
    skipApprovalGates: config.skip_approval_gates,
    maxSteps: config.queue?.max_steps,
  });
}

// ---------------------------------------------------------------------------
// buildQueueForSlashCommand — create queue from a slash command
// ---------------------------------------------------------------------------

/**
 * Build a Queue for a slash command.
 *
 * Maps known commands to their workflow templates. Unknown commands fall back to work.
 *
 * @param command The slash command name (without /)
 * @param config FlywheelConfig
 * @returns A new Queue
 */
export function buildQueueForSlashCommand(command: string, config: FlywheelConfig): Queue {
  const templateMap: Record<string, WorkflowName> = {
    work: "work",
    sprint: "sprint",
  };

  const workflowName: WorkflowName = templateMap[command] ?? "work";
  return buildQueue(workflowName, config);
}


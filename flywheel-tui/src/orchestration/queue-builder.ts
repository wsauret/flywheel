/**
 * Queue Builder — queue-based workflow composition (simplified: work only).
 *
 * Contains:
 *   - `buildQueue` — pure function to create a Queue from a WorkflowName + config
 *   - `buildQueueForSlashCommand` — creates queue from slash command name + config
 *   - `QueueProgressInfo` — progress tracking type for telemetry bar
 *   - `formatQueueProgress` — format progress string for display
 *   - `createEndOfSessionGate` — validation state gate
 */

import * as path from "node:path";
import {
  buildQueueFromTemplate,
  type WorkflowName,
} from "../workflows/queue/templates";
import type { Queue, Step, StepType, EndOfSessionGateCheck } from "../workflows/queue/types";
import { createQueue } from "../workflows/queue/queue";
import type { FlywheelConfig } from "./config/loader";
import { checkEndOfSessionGate } from "./session/validation-state";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// QueueProgressInfo — queue progress tracking for telemetry bar
// ---------------------------------------------------------------------------

export interface QueueProgressInfo {
  /** 1-based index of the current step. */
  currentStep: number;
  /** Total number of steps in the queue. */
  totalSteps: number;
  /** Name/type of the current step. */
  stepName: string;
}

// ---------------------------------------------------------------------------
// formatQueueProgress — format queue progress string for display
// ---------------------------------------------------------------------------

/**
 * Format a queue progress indicator string.
 *
 * @example formatQueueProgress({ currentStep: 1, totalSteps: 3, stepName: "plan" }) → "Plan (1/3)"
 */
function formatQueueProgress(info: QueueProgressInfo | null | undefined): string {
  if (!info || !info.currentStep || !info.totalSteps) return "";
  const name = info.stepName.charAt(0).toUpperCase() + info.stepName.slice(1);
  return `${name} (${info.currentStep}/${info.totalSteps})`;
}

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
 * Creates a single work step queue. Unknown commands fall back to work.
 *
 * @param command The slash command name (without /)
 * @param config FlywheelConfig
 * @returns A new Queue
 */
export function buildQueueForSlashCommand(command: string, config: FlywheelConfig): Queue {
  // All commands produce a single work step
  return createQueue([{
    id: randomUUID(),
    type: "work" as StepType,
    title: `Execute ${command}`,
    status: "pending",
  }], { maxSteps: config.queue?.max_steps });
}

// ---------------------------------------------------------------------------
// End-of-session gate factory (re-exported for shell use)
// ---------------------------------------------------------------------------

/**
 * Create an end-of-session gate check function.
 *
 * The gate reads `validation-state.json` from the project root and verifies
 * that all assertions have passed before declaring queue completion.
 */
function createEndOfSessionGate(
  config: FlywheelConfig,
  projectCwd: string,
): EndOfSessionGateCheck {
  const validationStatePath = path.resolve(projectCwd, "validation-state.json");

  return async () => {
    return checkEndOfSessionGate(validationStatePath, {
      skipScrutiny: config.skip_scrutiny,
      skipValidation: config.skip_validation,
    });
  };
}

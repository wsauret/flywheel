/**
 * Shell Queue — queue-based workflow composition and step executor factory.
 *
 * Replaces shell-pipeline.ts. Contains:
 *   - `buildQueue` — pure function to create a Queue from a WorkflowName + config
 *   - `buildQueueForSlashCommand` — creates queue from slash command name + config
 *   - `createShellStepExecutor` — factory for StepExecutor used by the shell
 *   - `QueueProgressInfo` — progress tracking type for telemetry bar
 *   - `formatQueueProgress` — format progress string for display
 *   - `createEndOfSessionGate` — validation state gate (re-exported from shell-pipeline)
 *
 * Terminology:
 *   Queue    — mutable, ordered list of steps for a session
 *   Step     — single unit of work (replaces "phase")
 *   Workflow — named template that generates an initial queue
 */

import * as path from "node:path";
import { buildQueueFromTemplate, type WorkflowName } from "../../queue/templates";
import type { Queue, StepType } from "../../queue/types";
import { createQueue } from "../../queue/queue";
import type { FlywheelConfig } from "../../config/loader";
import { checkEndOfSessionGate } from "../../controller/validation-state";
import type { EndOfSessionGateCheck } from "../../controller/workflow-pipeline";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// QueueProgressInfo — replaces PipelineStageInfo for telemetry bar
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
// formatQueueProgress — replaces formatPipelineStage
// ---------------------------------------------------------------------------

/**
 * Format a queue progress indicator string.
 *
 * @example formatQueueProgress({ currentStep: 1, totalSteps: 3, stepName: "plan" }) → "Plan (1/3)"
 */
export function formatQueueProgress(info: QueueProgressInfo | null | undefined): string {
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
 * Delegates to `buildQueueFromTemplate` from the queue system,
 * threading config values (skip_approval_gates, queue.max_steps).
 *
 * @param workflowName The workflow template name
 * @param config FlywheelConfig
 * @returns A new Queue
 */
export function buildQueue(workflowName: WorkflowName, config: FlywheelConfig): Queue {
  return buildQueueFromTemplate(workflowName, {
    skipApprovalGates: config.skip_approval_gates,
    maxSteps: config.queue?.max_steps,
  });
}

// ---------------------------------------------------------------------------
// buildQueueForSlashCommand — create queue from a slash command
// ---------------------------------------------------------------------------

/** Valid step types that map directly to slash commands. */
const SLASH_COMMAND_STEP_TYPES: Record<string, StepType> = {
  work: "work",
  plan: "plan",
  review: "review",
  ship: "ship",
  debug: "debug",
  research: "research",
};

/**
 * Build a Queue for a slash command.
 *
 * For `/work` and `/plan` with auto_chain enabled, creates a multi-step
 * pipeline-like queue. Otherwise creates a single-step queue.
 *
 * @param command The slash command name (without /)
 * @param config FlywheelConfig
 * @returns A new Queue
 */
export function buildQueueForSlashCommand(command: string, config: FlywheelConfig): Queue {
  const stepType = SLASH_COMMAND_STEP_TYPES[command];
  if (!stepType) {
    // Unknown command — create single work step as fallback
    return createQueue([{
      id: randomUUID(),
      type: "work",
      title: `Execute ${command}`,
      status: "pending",
    }]);
  }

  // For auto_chain pipelines, use the template system
  if (config.auto_chain) {
    if (command === "plan") {
      return buildQueue("plan-work-review", config);
    }
    if (command === "work") {
      // work with auto_chain creates work + review
      const steps: import("../../queue/types").Step[] = [
        { id: randomUUID(), type: "work", title: "Execute work", status: "pending" },
        { id: randomUUID(), type: "review", title: "Review changes", status: "pending" },
      ];
      if (config.auto_ship) {
        steps.push({ id: randomUUID(), type: "ship", title: "Ship changes", status: "pending" });
      }
      return createQueue(steps, { maxSteps: config.queue?.max_steps });
    }
  }

  // Single-step queue for standalone commands
  return createQueue([{
    id: randomUUID(),
    type: stepType,
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
export function createEndOfSessionGate(
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

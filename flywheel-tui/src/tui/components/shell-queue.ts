/**
 * Shell Queue — queue-based workflow composition and step executor factory.
 *
 * Queue-based workflow composition. Contains:
 *   - `buildQueue` — pure function to create a Queue from a WorkflowName + config
 *   - `buildQueueForSlashCommand` — creates queue from slash command name + config
 *   - `createShellStepExecutor` — factory for StepExecutor used by the shell
 *   - `QueueProgressInfo` — progress tracking type for telemetry bar
 *   - `formatQueueProgress` — format progress string for display
 *   - `createEndOfSessionGate` — validation state gate
 *
 * Terminology:
 *   Queue    — mutable, ordered list of steps for a session
 *   Step     — single unit of work (replaces "step")
 *   Workflow — named template that generates an initial queue
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { buildQueueFromTemplate, type WorkflowName } from "../../queue/templates";
import type { Queue, Step, StepType } from "../../queue/types";
import { createQueue } from "../../queue/queue";
import type { FlywheelConfig } from "../../config/loader";
import { checkEndOfSessionGate } from "../../controller/validation-state";
import type { EndOfSessionGateCheck } from "../../controller/queue-types";
import { parseJsonPlan } from "../../controller/plan-json-parser";
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
 * multi-step queue. Otherwise creates a single-step queue.
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

  // For auto_chain queues, use the template system
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
// buildQueueFromPlan — parse plan file and create work steps
// ---------------------------------------------------------------------------

/**
 * Build a Queue from a plan file path by parsing its steps into work steps.
 *
 * Parses JSON plan files, with each step preserving full metadata
 * (description, acceptanceCriteria, fileReferences, feature, fulfills, milestone).
 *
 * @param planPath Path to the plan file (.plan.json)
 * @param config FlywheelConfig
 * @returns A new Queue with work steps from the plan
 */
export function buildQueueFromPlan(planPath: string, config: FlywheelConfig): Queue {
  let planContent: string;
  try {
    planContent = fs.readFileSync(planPath, "utf-8");
  } catch {
    // If plan file can't be read, fall back to a single work step
    return createQueue([{
      id: randomUUID(),
      type: "work" as StepType,
      title: "Execute work",
      status: "pending",
    }], { maxSteps: config.queue?.max_steps });
  }

  return buildQueueFromJsonPlan(planContent, config);
}

/**
 * Build queue from a JSON plan file.
 */
function buildQueueFromJsonPlan(planContent: string, config: FlywheelConfig): Queue {
  const result = parseJsonPlan(planContent);

  if (!result.ok || result.plan.steps.length === 0) {
    // Invalid or empty JSON plan — fall back to single work step
    return createQueue([{
      id: randomUUID(),
      type: "work" as StepType,
      title: "Execute work",
      status: "pending",
    }], { maxSteps: config.queue?.max_steps });
  }

  // Convert each JSON plan step to a queue work step with full metadata
  const steps: Step[] = result.plan.steps.map((planStep) => ({
    id: randomUUID(),
    type: "work" as StepType,
    title: planStep.title,
    status: "pending" as const,
    description: planStep.description,
    acceptanceCriteria: planStep.acceptanceCriteria,
    fileReferences: planStep.fileReferences,
    feature: planStep.feature,
    fulfills: planStep.fulfills,
    milestone: planStep.milestone,
  }));

  // If auto_chain is on, add review (and ship if auto_ship) after work steps
  appendAutoChainSteps(steps, config);

  return createQueue(steps, { maxSteps: config.queue?.max_steps });
}

/**
 * Append review/ship steps when auto_chain is enabled.
 */
function appendAutoChainSteps(steps: Step[], config: FlywheelConfig): void {
  if (config.auto_chain) {
    steps.push({
      id: randomUUID(),
      type: "review" as StepType,
      title: "Review changes",
      status: "pending",
    });
    if (config.auto_ship) {
      steps.push({
        id: randomUUID(),
        type: "ship" as StepType,
        title: "Ship changes",
        status: "pending",
      });
    }
  }
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

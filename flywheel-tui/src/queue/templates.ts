// ---------------------------------------------------------------------------
// Queue System — Workflow Templates
// ---------------------------------------------------------------------------
//
// Named workflow templates. Each template defines
// a buildQueue() function returning the initial Step[] for a session.
//
// Templates:
//   plan-only       — single plan step
//   plan-work       — plan step; work steps inserted after plan completes
//   plan-work-review — plan + review; work steps inserted between
//   full            — plan + review + ship; work steps inserted after plan
//   sprint          — work + verify
//
// When skip_approval_gates is false, gate steps are inserted between major
// step type transitions.
//
// Terminology:
//   Workflow  — named template generating an initial queue
//   Step      — single unit of work (replaces "phase")
//   Queue     — mutable, ordered list of steps
// ---------------------------------------------------------------------------

import { randomUUID } from "crypto";
import { createQueue, type QueueOptions } from "./queue";
import type { Step, Queue, StepType, WorkflowTemplate } from "./types";

// ---------------------------------------------------------------------------
// WorkflowName — the 5 supported workflow template names
// ---------------------------------------------------------------------------

export type WorkflowName =
  | "plan-only"
  | "plan-work"
  | "plan-work-review"
  | "full"
  | "sprint";

// ---------------------------------------------------------------------------
// BuildQueueOptions — configuration for queue building
// ---------------------------------------------------------------------------

export interface BuildQueueOptions {
  /** When false, gate steps are inserted between major transitions. Default: true (no gates). */
  skipApprovalGates?: boolean;
  /** Maximum number of steps in the queue. */
  maxSteps?: number;
}

// ---------------------------------------------------------------------------
// Step factory helpers
// ---------------------------------------------------------------------------

function makeStep(type: StepType, title: string): Step {
  return {
    id: randomUUID(),
    type,
    title,
    status: "pending",
  };
}

function makeGateStep(title: string): Step {
  return makeStep("gate", title);
}

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

/**
 * Build the initial step list for a template, optionally inserting gates.
 */
function buildPlanOnlySteps(): Step[] {
  return [makeStep("plan", "Create plan")];
}

function buildPlanWorkSteps(): Step[] {
  // Only plan initially — work steps are deferred until plan completes
  return [makeStep("plan", "Create plan")];
}

function buildPlanWorkReviewSteps(insertGates: boolean): Step[] {
  const steps: Step[] = [makeStep("plan", "Create plan")];
  // Work steps will be inserted between plan and review after plan completes
  if (insertGates) {
    steps.push(makeGateStep("Approve plan before review"));
  }
  steps.push(makeStep("review", "Review changes"));
  return steps;
}

function buildFullSteps(insertGates: boolean): Step[] {
  const steps: Step[] = [makeStep("plan", "Create plan")];
  // Work steps will be inserted between plan and review after plan completes
  if (insertGates) {
    steps.push(makeGateStep("Approve plan before review"));
  }
  steps.push(makeStep("review", "Review changes"));
  if (insertGates) {
    steps.push(makeGateStep("Approve review before ship"));
  }
  steps.push(makeStep("ship", "Ship changes"));
  return steps;
}

function buildSprintSteps(): Step[] {
  return [
    makeStep("work", "Sprint work"),
    makeStep("verify", "Verify changes"),
  ];
}

// ---------------------------------------------------------------------------
// Workflow template registry
// ---------------------------------------------------------------------------

export interface WorkflowTemplateWithBuilder extends WorkflowTemplate {
  /** Build the initial queue for this workflow. */
  buildSteps(insertGates: boolean): Step[];
}

const TEMPLATE_BUILDERS: Record<WorkflowName, WorkflowTemplateWithBuilder> = {
  "plan-only": {
    name: "plan-only",
    label: "Just Plan",
    description: "Create a plan only",
    initialStepTypes: ["plan"],
    buildSteps: () => buildPlanOnlySteps(),
  },
  "plan-work": {
    name: "plan-work",
    label: "Plan + Work",
    description: "Create a plan and execute it",
    initialStepTypes: ["plan"],
    buildSteps: () => buildPlanWorkSteps(),
  },
  "plan-work-review": {
    name: "plan-work-review",
    label: "Plan + Work + Review",
    description: "Create, execute, and review (recommended)",
    initialStepTypes: ["plan", "review"],
    buildSteps: (insertGates) => buildPlanWorkReviewSteps(insertGates),
  },
  "full": {
    name: "full",
    label: "Full Pipeline",
    description: "Create, execute, review, and ship",
    initialStepTypes: ["plan", "review", "ship"],
    buildSteps: (insertGates) => buildFullSteps(insertGates),
  },
  "sprint": {
    name: "sprint",
    label: "Sprint",
    description: "Fast iteration — implement, verify, retry",
    initialStepTypes: ["work", "verify"],
    buildSteps: () => buildSprintSteps(),
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * All workflow templates as an array (for display in pickers).
 */
export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = Object.values(TEMPLATE_BUILDERS);

/**
 * Look up a workflow template by name.
 */
export function getWorkflowTemplate(name: WorkflowName): WorkflowTemplate | undefined {
  return TEMPLATE_BUILDERS[name];
}

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
  const template = TEMPLATE_BUILDERS[name];
  if (!template) {
    throw new Error(`Unknown workflow template: ${name}`);
  }

  const insertGates = options?.skipApprovalGates === false;
  const steps = template.buildSteps(insertGates);

  const queueOpts: QueueOptions | undefined = options?.maxSteps
    ? { maxSteps: options.maxSteps }
    : undefined;

  return createQueue(steps, queueOpts);
}

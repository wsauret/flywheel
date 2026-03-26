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

function makeStep(type: StepType, title: string, extra?: Partial<Step>): Step {
  return {
    id: randomUUID(),
    type,
    title,
    status: "pending",
    ...extra,
  };
}

function makeGateStep(title: string): Step {
  return makeStep("gate", title);
}

// ---------------------------------------------------------------------------
// Granular step builders — ADR-004 requires visible sub-steps
// ---------------------------------------------------------------------------

/**
 * Plan sub-steps per ADR-004 Decision 3:
 *   1. research codebase
 *   2. draft implementation plan
 *   3. review plan
 *   4. consolidate findings
 */
function buildGranularPlanSteps(): Step[] {
  return [
    makeStep("plan", "Research codebase", {
      dispatcherHint: "research",
      evaluationCriteria: "Produces a .context.md with file references and architectural summary",
      toolScoping: { read: true, bash: true, write: true, edit: false },
    }),
    makeStep("plan", "Draft implementation plan", {
      dispatcherHint: "draft",
      evaluationCriteria: "Produces a structured JSON plan with steps, behavioralContract, decisions, and risks",
    }),
    makeStep("plan", "Review plan", {
      dispatcherHint: "review",
      evaluationCriteria: "Produces annotated JSON with review findings and open questions without modifying draft fields",
      toolScoping: { read: true, bash: true, write: true, edit: false },
    }),
    makeStep("plan", "Consolidate findings", {
      dispatcherHint: "consolidate",
      evaluationCriteria: "Produces clean JSON plan with findings incorporated and review annotations stripped",
      hitl: { prompt: "Review open questions from plan review before consolidation", enabled: false },
    }),
  ];
}

/**
 * Review sub-steps per ADR-004 Decision 3:
 *   1. multi-agent code review
 *   2. consolidate findings
 *   3. implement fixes
 */
function buildGranularReviewSteps(): Step[] {
  return [
    makeStep("review", "Multi-agent code review", {
      dispatcherHint: "dispatch-reviewers",
      evaluationCriteria: "Dispatches multiple review agents and produces a consolidated review document",
      toolScoping: { read: true, bash: true, write: true, edit: false },
    }),
    makeStep("review", "Consolidate review findings", {
      dispatcherHint: "consolidate-review",
      evaluationCriteria: "Produces a prioritized list of findings with severity levels",
    }),
    makeStep("review", "Implement review fixes", {
      dispatcherHint: "implement-fixes",
      evaluationCriteria: "All P1 findings addressed, P2 findings addressed or justified as deferred",
    }),
  ];
}

/**
 * Ship sub-steps per ADR-004 Decision 3:
 *   1. stage changes
 *   2. create commit
 *   3. open pull request
 *   4. extract learnings
 */
function buildGranularShipSteps(): Step[] {
  return [
    makeStep("ship", "Stage changes", {
      dispatcherHint: "stage",
      evaluationCriteria: "All relevant changes staged for commit",
    }),
    makeStep("ship", "Create commit", {
      dispatcherHint: "commit",
      evaluationCriteria: "Commit created with descriptive message",
    }),
    makeStep("ship", "Open pull request", {
      dispatcherHint: "pr",
      evaluationCriteria: "Pull request opened with description and linked issues",
    }),
    makeStep("ship", "Extract learnings", {
      dispatcherHint: "learnings",
      evaluationCriteria: "Learnings extracted and saved to docs/solutions/",
    }),
  ];
}

// ---------------------------------------------------------------------------
// Template definitions — expanded to granular sub-steps per ADR-004
// ---------------------------------------------------------------------------

/**
 * Build the initial step list for a template, optionally inserting gates.
 */
function buildPlanOnlySteps(): Step[] {
  return buildGranularPlanSteps();
}

function buildPlanWorkSteps(): Step[] {
  // Plan sub-steps initially — work steps inserted after plan completes
  return buildGranularPlanSteps();
}

function buildPlanWorkReviewSteps(insertGates: boolean): Step[] {
  const steps: Step[] = [...buildGranularPlanSteps()];
  // Work steps will be inserted between plan and review after plan completes
  if (insertGates) {
    steps.push(makeGateStep("Approve plan before review"));
  }
  steps.push(...buildGranularReviewSteps());
  return steps;
}

function buildFullSteps(insertGates: boolean): Step[] {
  const steps: Step[] = [...buildGranularPlanSteps()];
  // Work steps will be inserted between plan and review after plan completes
  if (insertGates) {
    steps.push(makeGateStep("Approve plan before review"));
  }
  steps.push(...buildGranularReviewSteps());
  if (insertGates) {
    steps.push(makeGateStep("Approve review before ship"));
  }
  steps.push(...buildGranularShipSteps());
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
    initialStepTypes: ["plan", "plan", "plan", "plan"],
    buildSteps: () => buildPlanOnlySteps(),
  },
  "plan-work": {
    name: "plan-work",
    label: "Plan + Work",
    description: "Create a plan and execute it",
    initialStepTypes: ["plan", "plan", "plan", "plan"],
    buildSteps: () => buildPlanWorkSteps(),
  },
  "plan-work-review": {
    name: "plan-work-review",
    label: "Plan + Work + Review",
    description: "Create, execute, and review (recommended)",
    initialStepTypes: ["plan", "plan", "plan", "plan", "review", "review", "review"],
    buildSteps: (insertGates) => buildPlanWorkReviewSteps(insertGates),
  },
  "full": {
    name: "full",
    label: "Full Pipeline",
    description: "Create, execute, review, and ship",
    initialStepTypes: ["plan", "plan", "plan", "plan", "review", "review", "review", "ship", "ship", "ship", "ship"],
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

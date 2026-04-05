/**
 * DispatcherInput assembler — transforms raw plan/state content
 * into the structured DispatcherInput with budget-aware truncation.
 *
 * Parses JSON plans directly via parseJsonPlan.
 *
 * Single safety-valve cap: 100KB total. If the assembled input exceeds
 * this cap, available_context arrays are truncated to 10 entries each
 * (via the shared applyBudgetTruncation helper).
 */

import type { DispatcherInput, DispatcherConfig, WorkflowInfo } from "./schemas.js";
import type { SessionBudgetStatus, AvailableContext, LastWorkerResult } from "../schemas.js";
import type { StepContext } from "../queue/step-context.js";
import { parseJsonPlan } from "../queue/shared/plan-parser.js";
import { parseContextFile } from "../utils/file-cache.js";
import { applyBudgetTruncation } from "./truncation.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AssemblerInput {
  planContent: string;
  stateContent: string;
  contextContent?: string;
  lastWorkerResult?: LastWorkerResult | null;
  /** Workflow step context for the dispatcher */
  workflowContext: {
    workflowId: string;
    name: string;
    stepNumber: number;
    totalSteps: number;
    stepDescription: string;
  };
  /** Runtime config subset for the dispatcher */
  configContext: {
    maxEvalCycles: number;
    worktreePath: string;
    projectCwd: string;
    workerModel: string;
    dispatcherModel: string;
  };
  /** Budget status for the dispatcher */
  sessionBudget: SessionBudgetStatus;
  /** Available context (conventions, standards, learnings) */
  availableContext: AvailableContext;
  /** Cumulative step context from completed steps (optional) */
  stepContext?: StepContext;
}

export interface AssembledInput {
  input: DispatcherInput;
  planTruncated: boolean;
  historyTruncated: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function assembleDispatcherInput(raw: AssemblerInput): AssembledInput {
  // Build plan steps for DispatcherInput from JSON plan content
  const planSteps = buildJsonPlanSteps(raw.planContent);

  // State tracking — no longer parsed from .state.md files.
  // Default to empty completed steps and index 0.
  const completedSteps: number[] = [];
  const currentStepIndex = 0;

  // Parse context files
  const contextFiles = raw.contextContent
    ? parseContextFile(raw.contextContent)
    : [];

  // Tracking flags
  let planTruncated = false;
  let historyTruncated = false;

  const lastWorkerResultObj: LastWorkerResult | null = raw.lastWorkerResult ?? null;

  const workflowInfo: WorkflowInfo = {
    name: raw.workflowContext.name,
    step_number: raw.workflowContext.stepNumber,
    total_steps: raw.workflowContext.totalSteps,
    step_description: raw.workflowContext.stepDescription,
  };

  const dispatcherConfig: DispatcherConfig = {
    max_eval_cycles: raw.configContext.maxEvalCycles,
    worktree_path: raw.configContext.worktreePath,
    project_cwd: raw.configContext.projectCwd,
    worker_model: raw.configContext.workerModel,
    dispatcher_model: raw.configContext.dispatcherModel,
  };

  const input: DispatcherInput = {
    plan: { steps: planSteps },
    state: {
      // New step-based fields
      completed_steps: completedSteps,
      current_step_index: currentStepIndex,
    },
    context: { files: contextFiles },
    plan_truncated: planTruncated,
    history_truncated: historyTruncated,
    workflow_id: raw.workflowContext.workflowId,
    workflow: workflowInfo,
    last_worker_result: lastWorkerResultObj,
    config: dispatcherConfig,
    session_budget: raw.sessionBudget,
    available_context: raw.availableContext,
    step_context: raw.stepContext,
  };

  // Safety valve — shared 100KB budget truncation on available_context
  applyBudgetTruncation(input);

  return {
    input,
    planTruncated,
    historyTruncated,
  };
}

// ---------------------------------------------------------------------------
// Plan step builders
// ---------------------------------------------------------------------------

/**
 * Build plan steps from JSON plan content.
 * Maps JSON plan steps directly to the dispatcher's step-based schema.
 */
function buildJsonPlanSteps(content: string): Array<{
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  fileReferences?: string[];
  feature?: string;
  fulfills?: string[];
}> {
  const result = parseJsonPlan(content);
  if (!result.ok) return [];

  return result.plan.steps.map((s) => ({
    title: s.title,
    description: s.description,
    acceptanceCriteria: s.acceptanceCriteria,
    fileReferences: s.fileReferences,
    feature: s.feature,
    fulfills: s.fulfills,
  }));
}




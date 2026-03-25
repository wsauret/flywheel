/**
 * DispatcherInput assembler — transforms raw plan/state content
 * into the structured DispatcherInput with budget-aware truncation.
 *
 * Single safety-valve cap: 100KB total. If the assembled input exceeds
 * this cap, available_context arrays are truncated to 10 entries each.
 * Per-field sub-budgets were removed — context is passed through as-is
 * unless the total overflows.
 */

import type { DispatcherInput, DispatcherConfig, WorkflowInfo } from "../schemas/dispatcher";
import type { SessionBudgetStatus, AvailableContext, LastWorkerResult } from "../schemas/shared";
import type { StageContext } from "../controller/stage-context";
import { parsePlan } from "../controller/plan-parser";
import { parseStateFile } from "../state/reader";
import { parseContextFile } from "../controller/templates";

// ---------------------------------------------------------------------------
// Budget constant (bytes) — single safety-valve cap
// ---------------------------------------------------------------------------

const BUDGET_TOTAL = 102400; // 100KB

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
  /** Cumulative stage context from completed phases (optional) */
  stageContext?: StageContext;
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
  // Parse plan
  const phases = parsePlan(raw.planContent);

  // Parse state (gracefully handle empty/missing)
  const state = raw.stateContent
    ? parseStateFile(raw.stateContent)
    : { frontmatter: {}, title: "", phases: [], keyDecisions: [], errorLog: [] };

  // Determine completed phases and current index
  const completedPhases: number[] = [];
  let currentPhaseIndex = 0;
  let foundPending = false;

  for (let i = 0; i < state.phases.length; i++) {
    if (state.phases[i].status === "completed") {
      completedPhases.push(i);
    } else if (!foundPending) {
      currentPhaseIndex = i;
      foundPending = true;
    }
  }

  // If all completed, current is beyond last
  if (!foundPending && state.phases.length > 0) {
    currentPhaseIndex = state.phases.length;
  }

  // Parse context files
  const contextFiles = raw.contextContent
    ? parseContextFile(raw.contextContent)
    : [];

  // Build plan phases for DispatcherInput
  const planPhases = phases.map((p) => ({
    name: p.title,
    steps: p.steps.map((s) => ({ description: s })),
  }));

  // Tracking flags
  let planTruncated = false;
  let historyTruncated = false;

  // Structured lastWorkerResult (from handoff) or null
  const lastWorkerResultObj: LastWorkerResult | null = raw.lastWorkerResult ?? null;

  // Build workflow info (required)
  const workflowInfo: WorkflowInfo = {
    name: raw.workflowContext.name,
    step_number: raw.workflowContext.stepNumber,
    total_steps: raw.workflowContext.totalSteps,
    step_description: raw.workflowContext.stepDescription,
  };

  // Build dispatcher config (required)
  const dispatcherConfig: DispatcherConfig = {
    max_eval_cycles: raw.configContext.maxEvalCycles,
    worktree_path: raw.configContext.worktreePath,
    project_cwd: raw.configContext.projectCwd,
    worker_model: raw.configContext.workerModel,
    dispatcher_model: raw.configContext.dispatcherModel,
  };

  // Build the input
  const input: DispatcherInput = {
    plan: { phases: planPhases },
    state: {
      completed_phases: completedPhases,
      current_phase_index: currentPhaseIndex,
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
    stage_context: raw.stageContext,
  };

  // Safety valve — if total exceeds 100KB, truncate available_context as last resort
  if (byteLength(JSON.stringify(input)) > BUDGET_TOTAL) {
    input.available_context = {
      conventions: input.available_context.conventions.slice(0, 10),
      standards: input.available_context.standards.slice(0, 10),
      learnings: input.available_context.learnings.slice(0, 10),
    };
  }

  return {
    input,
    planTruncated,
    historyTruncated,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function byteLength(str: string): number {
  return Buffer.byteLength(str, "utf8");
}




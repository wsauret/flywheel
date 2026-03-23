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
  lastWorkerResult?: string | LastWorkerResult | null;
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

  // Parse lastWorkerResult — accept structured object or skip raw strings
  let lastWorkerResultObj: LastWorkerResult | null = null;
  if (raw.lastWorkerResult != null) {
    if (typeof raw.lastWorkerResult === "string") {
      // Legacy string path: try to parse as JSON, otherwise skip
      try {
        const parsed = JSON.parse(raw.lastWorkerResult);
        if (parsed && typeof parsed === "object" && "step" in parsed && "status" in parsed) {
          lastWorkerResultObj = parsed as LastWorkerResult;
        }
      } catch {
        // Not parseable — drop silently (raw strings can't populate the structured schema)
      }
    } else {
      lastWorkerResultObj = raw.lastWorkerResult;
    }
  }

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

/**
 * Truncate plan phases to fit within a byte budget.
 * Keeps as many complete phases as possible, truncating step descriptions.
 */
function truncatePlanPhases(
  phases: Array<{ name: string; steps: Array<{ description: string }> }>,
  budget: number,
): Array<{ name: string; steps: Array<{ description: string }> }> {
  const result: Array<{ name: string; steps: Array<{ description: string }> }> = [];

  for (const phase of phases) {
    const truncatedPhase = {
      name: phase.name,
      steps: phase.steps.map((s) => ({
        description: s.description.length > 100
          ? s.description.slice(0, 100) + "..."
          : s.description,
      })),
    };

    result.push(truncatedPhase);

    if (byteLength(JSON.stringify(result)) > budget) {
      // Remove the last phase if it pushed over budget
      result.pop();
      break;
    }
  }

  // If even a single phase is too large, return it truncated
  if (result.length === 0 && phases.length > 0) {
    result.push({
      name: phases[0].name,
      steps: phases[0].steps.slice(0, 3).map((s) => ({
        description: s.description.slice(0, 50) + "...",
      })),
    });
  }

  return result;
}


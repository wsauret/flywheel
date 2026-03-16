/**
 * DispatcherInput assembler — transforms raw plan/state content
 * into the structured DispatcherInput with budget-aware truncation.
 *
 * Budget allocations (bytes):
 *   Plan:               2048
 *   Last worker result:  1024
 *   History:             1536
 *   Learnings:            512
 *   Total:              5120 (5KB)
 */

import type { DispatcherInput } from "../schemas/dispatcher";
import { parsePlan } from "../controller/plan-parser";
import { parseStateFile } from "../state/reader";
import { parseContextFile } from "../controller/templates";

// ---------------------------------------------------------------------------
// Budget constants (bytes)
// ---------------------------------------------------------------------------

const BUDGET_PLAN = 2048;
const BUDGET_LAST_RESULT = 1024;
const BUDGET_HISTORY = 1536;
const BUDGET_LEARNINGS = 512;
const BUDGET_TOTAL = 5120;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AssemblerInput {
  planContent: string;
  stateContent: string;
  contextContent?: string;
  lastWorkerResult?: string;
  learnings?: string[];
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

  // Apply budget truncation
  let planTruncated = false;
  let historyTruncated = false;

  // Truncate plan phases to fit within BUDGET_PLAN bytes
  let truncatedPlanPhases = planPhases;
  let planJson = JSON.stringify(truncatedPlanPhases);

  if (byteLength(planJson) > BUDGET_PLAN) {
    planTruncated = true;
    truncatedPlanPhases = truncatePlanPhases(planPhases, BUDGET_PLAN);
  }

  // Truncate learnings to fit within BUDGET_LEARNINGS bytes
  let relevantLearnings: string[] | undefined;
  if (raw.learnings && raw.learnings.length > 0) {
    relevantLearnings = truncateLearnings(raw.learnings, BUDGET_LEARNINGS);
  }

  // Build the input
  const input: DispatcherInput = {
    plan: { phases: truncatedPlanPhases },
    state: {
      completed_phases: completedPhases,
      current_phase_index: currentPhaseIndex,
    },
    context: { files: contextFiles },
    ...(relevantLearnings ? { relevant_learnings: relevantLearnings } : {}),
    plan_truncated: planTruncated,
    history_truncated: historyTruncated,
  };

  // Check total budget
  let serialized = JSON.stringify(input);
  if (byteLength(serialized) > BUDGET_TOTAL) {
    // Aggressively truncate: remove context files, truncate plan further
    input.context.files = input.context.files.slice(0, 5);
    input.plan.phases = truncatePlanPhases(input.plan.phases, BUDGET_PLAN / 2);
    input.plan_truncated = true;
    planTruncated = true;
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
  return new TextEncoder().encode(str).length;
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

/**
 * Truncate learnings array to fit within a byte budget.
 * Keeps as many complete learnings as possible.
 */
function truncateLearnings(learnings: string[], budget: number): string[] {
  const result: string[] = [];
  let currentBytes = 2; // JSON array brackets []

  for (const learning of learnings) {
    const entryBytes = byteLength(JSON.stringify(learning)) + (result.length > 0 ? 1 : 0); // comma
    if (currentBytes + entryBytes > budget && result.length > 0) break;
    result.push(learning);
    currentBytes += entryBytes;
  }

  return result;
}

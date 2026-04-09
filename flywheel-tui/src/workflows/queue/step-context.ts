/**
 * StepContext — cumulative accumulator that grows as steps complete
 * within a queue execution.
 *
 * After each step, decisions, warnings, artifacts, issues, and skill
 * feedback are accumulated into the context. The dispatcher for step N
 * receives the cumulative context from steps 1 through N-1.
 *
 * Persisted to disk via atomicWrite so queue restart/resume can
 * reload accumulated state.
 */

import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "../shared/atomic-write";
import { Log } from "../../infra/log";
import { errorMessage } from "../../infra/error-message";
import type { SkillFeedback } from "../../infra/handoff-schemas";

const log = Log.create({ service: "step-context" });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Relative path within .flywheel/ for step context persistence */
export const STEP_CONTEXT_FILE = ".flywheel/step-context.json";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const StepDecisionsSchema = z.object({
  step_index: z.number(),
  step_title: z.string(),
  decisions: z.array(z.string()),
});

const StepWarningsSchema = z.object({
  step_index: z.number(),
  step_title: z.string(),
  warnings: z.array(z.string()),
});

const StepArtifactsSchema = z.object({
  step_index: z.number(),
  step_title: z.string(),
  artifacts: z.array(z.string()),
});

const StepIssuesSchema = z.object({
  step_index: z.number(),
  step_title: z.string(),
  issues: z.array(z.string()),
});

const SkillFeedbackEntrySchema = z.object({
  step_index: z.number(),
  step_title: z.string(),
  followedProcedure: z.boolean(),
  deviations: z.array(z.object({
    step: z.string(),
    whatIDidInstead: z.string(),
    why: z.string(),
  })),
  suggestedChanges: z.array(z.string()).optional(),
});

export const StepContextSchema = z.object({
  cumulative_decisions: z.array(StepDecisionsSchema),
  cumulative_warnings: z.array(StepWarningsSchema),
  cumulative_artifacts: z.array(StepArtifactsSchema),
  cumulative_issues: z.array(StepIssuesSchema),
  skill_feedback: z.array(SkillFeedbackEntrySchema),
  step_count: z.number().min(0),
});

export type StepContext = z.infer<typeof StepContextSchema>;

// ---------------------------------------------------------------------------
// StepHandoffSummary — the per-step data fed into the accumulator
// ---------------------------------------------------------------------------

export interface StepHandoffSummary {
  step_index: number;
  step_title: string;
  decisions: string[];
  warnings: string[];
  artifacts: string[];
  issues: string[];
  skill_feedback?: SkillFeedback;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh empty StepContext.
 */
export function createEmptyStepContext(): StepContext {
  return {
    cumulative_decisions: [],
    cumulative_warnings: [],
    cumulative_artifacts: [],
    cumulative_issues: [],
    skill_feedback: [],
    step_count: 0,
  };
}

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

/**
 * Accumulate a completed step's handoff data into the step context.
 *
 * Returns a NEW StepContext object (does not mutate the input).
 * Skips adding entries for empty arrays to keep the context compact.
 */
export function accumulateStepIntoContext(
  ctx: StepContext,
  handoff: StepHandoffSummary,
): StepContext {
  const updated = {
    cumulative_decisions: [...ctx.cumulative_decisions],
    cumulative_warnings: [...ctx.cumulative_warnings],
    cumulative_artifacts: [...ctx.cumulative_artifacts],
    cumulative_issues: [...ctx.cumulative_issues],
    skill_feedback: [...ctx.skill_feedback],
    step_count: ctx.step_count + 1,
  };

  // Only add entries for non-empty data to keep context compact
  if (handoff.decisions.length > 0) {
    updated.cumulative_decisions.push({
      step_index: handoff.step_index,
      step_title: handoff.step_title,
      decisions: handoff.decisions,
    });
  }

  if (handoff.warnings.length > 0) {
    updated.cumulative_warnings.push({
      step_index: handoff.step_index,
      step_title: handoff.step_title,
      warnings: handoff.warnings,
    });
  }

  if (handoff.artifacts.length > 0) {
    updated.cumulative_artifacts.push({
      step_index: handoff.step_index,
      step_title: handoff.step_title,
      artifacts: handoff.artifacts,
    });
  }

  if (handoff.issues.length > 0) {
    updated.cumulative_issues.push({
      step_index: handoff.step_index,
      step_title: handoff.step_title,
      issues: handoff.issues,
    });
  }

  if (handoff.skill_feedback) {
    updated.skill_feedback.push({
      step_index: handoff.step_index,
      step_title: handoff.step_title,
      followedProcedure: handoff.skill_feedback.followedProcedure,
      deviations: handoff.skill_feedback.deviations,
      suggestedChanges: handoff.skill_feedback.suggestedChanges,
    });
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Persist step context to disk using atomicWrite.
 * File is written to `<projectCwd>/.flywheel/step-context.json`.
 */
export function persistStepContext(ctx: StepContext, projectCwd: string): void {
  const filePath = path.resolve(projectCwd, STEP_CONTEXT_FILE);
  const content = JSON.stringify(ctx, null, 2);
  writeFileAtomic(filePath, content);
  log.debug("step context persisted", { stepCount: ctx.step_count, path: filePath });
}

/**
 * Load step context from disk. Returns null if file doesn't exist,
 * is invalid JSON, or fails schema validation.
 *
 * Used on queue restart/resume to recover accumulated state.
 */
export function loadStepContext(projectCwd: string): StepContext | null {
  const filePath = path.resolve(projectCwd, STEP_CONTEXT_FILE);

  if (!fs.existsSync(filePath)) {
    log.debug("no step context file found", { path: filePath });
    return null;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const validated = StepContextSchema.parse(parsed);
    log.info("step context loaded from disk", { stepCount: validated.step_count });
    return validated;
  } catch (err) {
    log.warn("failed to load step context, starting fresh", {
      path: filePath,
      error: errorMessage(err),
    });
    return null;
  }
}

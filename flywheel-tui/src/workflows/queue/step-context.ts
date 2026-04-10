/**
 * StepContext — cumulative accumulator that grows as steps complete
 * within a queue execution.
 *
 * After each step, decisions, warnings, artifacts, issues, and skill
 * feedback are accumulated into the context. The dispatcher for step N
 * receives the cumulative context from steps 1 through N-1.
 */

import { z } from "zod";

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


/**
 * StageContext — cumulative accumulator that grows as phases complete
 * within a pipeline stage.
 *
 * After each phase, decisions, warnings, artifacts, issues, and skill
 * feedback are accumulated into the context. The dispatcher for phase N
 * receives the cumulative context from phases 1 through N-1.
 *
 * Persisted to disk via atomicWrite so pipeline restart/resume can
 * reload accumulated state. Resets between pipeline stages.
 *
 * Reference: inspiration/droid/RESEARCH-REPORT.md recommendation 2b
 */

import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "../utils/atomic-write";
import { Log } from "../utils/log";

const log = Log.create({ service: "stage-context" });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Relative path within .flywheel/ for stage context persistence */
export const STAGE_CONTEXT_FILE = ".flywheel/stage-context.json";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const PhaseDecisionsSchema = z.object({
  phase_index: z.number(),
  phase_title: z.string(),
  decisions: z.array(z.string()),
});

const PhaseWarningsSchema = z.object({
  phase_index: z.number(),
  phase_title: z.string(),
  warnings: z.array(z.string()),
});

const PhaseArtifactsSchema = z.object({
  phase_index: z.number(),
  phase_title: z.string(),
  artifacts: z.array(z.string()),
});

const PhaseIssuesSchema = z.object({
  phase_index: z.number(),
  phase_title: z.string(),
  issues: z.array(z.string()),
});

const SkillFeedbackEntrySchema = z.object({
  phase_index: z.number(),
  phase_title: z.string(),
  followedProcedure: z.boolean(),
  deviations: z.array(z.object({
    step: z.string(),
    whatIDidInstead: z.string(),
    why: z.string(),
  })),
  suggestedChanges: z.array(z.string()).optional(),
});

export const StageContextSchema = z.object({
  cumulative_decisions: z.array(PhaseDecisionsSchema),
  cumulative_warnings: z.array(PhaseWarningsSchema),
  cumulative_artifacts: z.array(PhaseArtifactsSchema),
  cumulative_issues: z.array(PhaseIssuesSchema),
  skill_feedback: z.array(SkillFeedbackEntrySchema),
  phase_count: z.number().min(0),
});

export type StageContext = z.infer<typeof StageContextSchema>;

// ---------------------------------------------------------------------------
// PhaseHandoffSummary — the per-phase data fed into the accumulator
// ---------------------------------------------------------------------------

export interface SkillFeedbackData {
  followedProcedure: boolean;
  deviations: Array<{ step: string; whatIDidInstead: string; why: string }>;
  suggestedChanges?: string[];
}

export interface PhaseHandoffSummary {
  phase_index: number;
  phase_title: string;
  decisions: string[];
  warnings: string[];
  artifacts: string[];
  issues: string[];
  skill_feedback?: SkillFeedbackData;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh empty StageContext.
 */
export function createEmptyStageContext(): StageContext {
  return {
    cumulative_decisions: [],
    cumulative_warnings: [],
    cumulative_artifacts: [],
    cumulative_issues: [],
    skill_feedback: [],
    phase_count: 0,
  };
}

/**
 * Reset stage context — alias for createEmptyStageContext.
 * Called when a new pipeline stage begins.
 */
export function resetStageContext(): StageContext {
  return createEmptyStageContext();
}

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

/**
 * Accumulate a completed phase's handoff data into the stage context.
 *
 * Returns a NEW StageContext object (does not mutate the input).
 * Skips adding entries for empty arrays to keep the context compact.
 */
export function accumulatePhaseIntoContext(
  ctx: StageContext,
  handoff: PhaseHandoffSummary,
): StageContext {
  const updated: StageContext = {
    cumulative_decisions: [...ctx.cumulative_decisions],
    cumulative_warnings: [...ctx.cumulative_warnings],
    cumulative_artifacts: [...ctx.cumulative_artifacts],
    cumulative_issues: [...ctx.cumulative_issues],
    skill_feedback: [...ctx.skill_feedback],
    phase_count: ctx.phase_count + 1,
  };

  // Only add entries for non-empty data to keep context compact
  if (handoff.decisions.length > 0) {
    updated.cumulative_decisions.push({
      phase_index: handoff.phase_index,
      phase_title: handoff.phase_title,
      decisions: handoff.decisions,
    });
  }

  if (handoff.warnings.length > 0) {
    updated.cumulative_warnings.push({
      phase_index: handoff.phase_index,
      phase_title: handoff.phase_title,
      warnings: handoff.warnings,
    });
  }

  if (handoff.artifacts.length > 0) {
    updated.cumulative_artifacts.push({
      phase_index: handoff.phase_index,
      phase_title: handoff.phase_title,
      artifacts: handoff.artifacts,
    });
  }

  if (handoff.issues.length > 0) {
    updated.cumulative_issues.push({
      phase_index: handoff.phase_index,
      phase_title: handoff.phase_title,
      issues: handoff.issues,
    });
  }

  if (handoff.skill_feedback) {
    updated.skill_feedback.push({
      phase_index: handoff.phase_index,
      phase_title: handoff.phase_title,
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
 * Persist stage context to disk using atomicWrite.
 * File is written to `<projectCwd>/.flywheel/stage-context.json`.
 */
export function persistStageContext(ctx: StageContext, projectCwd: string): void {
  const filePath = path.resolve(projectCwd, STAGE_CONTEXT_FILE);
  const content = JSON.stringify(ctx, null, 2);
  writeFileAtomic(filePath, content);
  log.debug("stage context persisted", { phaseCount: ctx.phase_count, path: filePath });
}

/**
 * Load stage context from disk. Returns null if file doesn't exist,
 * is invalid JSON, or fails schema validation.
 *
 * Used on pipeline restart/resume to recover accumulated state.
 */
export function loadStageContext(projectCwd: string): StageContext | null {
  const filePath = path.resolve(projectCwd, STAGE_CONTEXT_FILE);

  if (!fs.existsSync(filePath)) {
    log.debug("no stage context file found", { path: filePath });
    return null;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const validated = StageContextSchema.parse(parsed);
    log.info("stage context loaded from disk", { phaseCount: validated.phase_count });
    return validated;
  } catch (err) {
    log.warn("failed to load stage context, starting fresh", {
      path: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Start Command — Pipeline mode picker logic
 *
 * Pure functions and data for the `/start` guided workflow launcher.
 * The `/start` command collects a description and a pipeline mode,
 * then composes the appropriate PipelineStage[] for startPipeline().
 *
 * This is intentionally separate from `shell-pipeline.ts`, which handles
 * auto_chain config-driven pipeline composition. `/start` always uses
 * pipeline mode regardless of config.
 */

import type { PipelineStage } from "../../controller/workflow-pipeline"

// ---------------------------------------------------------------------------
// Pipeline mode types
// ---------------------------------------------------------------------------

export type PipelineMode = "plan-only" | "plan-work" | "plan-work-review" | "full" | "sprint"

export interface PipelineModeOption {
  label: string
  description: string
  value: PipelineMode
}

// ---------------------------------------------------------------------------
// Mode options (displayed in the question prompt)
// ---------------------------------------------------------------------------

export const PIPELINE_MODE_OPTIONS: PipelineModeOption[] = [
  {
    label: "Just Plan",
    description: "Create a plan only",
    value: "plan-only",
  },
  {
    label: "Plan + Work",
    description: "Create a plan and execute it",
    value: "plan-work",
  },
  {
    label: "Plan + Work + Review",
    description: "Create, execute, and review (recommended)",
    value: "plan-work-review",
  },
  {
    label: "Full Pipeline",
    description: "Create, execute, review, and ship",
    value: "full",
  },
  {
    label: "Sprint",
    description: "Fast iteration — implement, verify, retry",
    value: "sprint",
  },
]

// ---------------------------------------------------------------------------
// Mode helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the given pipeline mode includes a review stage.
 * Used to decide whether to show the "triage review findings" question.
 */
export function modeHasReview(mode: PipelineMode): boolean {
  return mode === "plan-work-review" || mode === "full"
}

// ---------------------------------------------------------------------------
// Pipeline builder (pure function)
// ---------------------------------------------------------------------------

/**
 * Build a PipelineStage[] from a user-selected pipeline mode.
 *
 * Unlike `buildPipelineStages` in shell-pipeline.ts (which reads config),
 * this function always returns exactly the stages the user chose.
 */
export function buildCustomPipeline(mode: PipelineMode): PipelineStage[] {
  switch (mode) {
    case "plan-only":
      return [{ workflow: "plan" }]
    case "plan-work":
      return [{ workflow: "plan" }, { workflow: "work" }]
    case "plan-work-review":
      return [{ workflow: "plan" }, { workflow: "work" }, { workflow: "review" }]
    case "full":
      return [
        { workflow: "plan" },
        { workflow: "work" },
        { workflow: "review" },
        { workflow: "ship" },
      ]
    case "sprint":
      return [{ workflow: "sprint" }]
  }
}

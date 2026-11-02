/**
 * The colours that the terminal's workflow surfaces share: an agent's state,
 * a summary's tone, and the chits of a workflow's progress. The card and
 * the agent view read them here, so one state reads in one colour
 * everywhere.
 */

import { fg as stFg, type RGBA, type TextChunk } from "@opentui/core"
import type { WorkflowAgentState } from "../../infra/output-blocks.js"
import { workflowChitGlyph, workflowChits, type WorkflowChitTone, type WorkflowUnitCounts } from "../../protocol/client/workflow-chits.js"

interface WorkflowPalette {
  readonly primary: RGBA
  readonly text: RGBA
  readonly textMuted: RGBA
  readonly borderSubtle: RGBA
  readonly success: RGBA
  readonly error: RGBA
  readonly warning: RGBA
}

export function agentStateColor(state: WorkflowAgentState, theme: Pick<WorkflowPalette, "success" | "error" | "primary" | "warning" | "textMuted">): RGBA {
  switch (state) {
    case "done": return theme.success
    case "failed": return theme.error
    case "running": return theme.primary
    case "parked": return theme.warning
    case "skipped":
    case "conditional":
    case "waiting":
    case "queued": return theme.textMuted
  }
}

function chitColor(tone: WorkflowChitTone, theme: Pick<WorkflowPalette, "success" | "error" | "primary" | "warning" | "borderSubtle">): RGBA {
  switch (tone) {
    case "done": return theme.success
    case "failed": return theme.error
    case "running": return theme.primary
    case "parked": return theme.warning
    case "pending": return theme.borderSubtle
  }
}

/** The chits of `counts` in at most `slots` columns, each in the colour of
 *  its state, as the card's plan bar and phase lines and the agent view's
 *  title line draw them. */
export function workflowChitChunks(counts: WorkflowUnitCounts, slots: number, theme: Pick<WorkflowPalette, "success" | "error" | "primary" | "warning" | "borderSubtle">): TextChunk[] {
  return workflowChits(counts, slots).map(({ tone, chits }) => stFg(chitColor(tone, theme))(workflowChitGlyph(tone).repeat(chits)))
}

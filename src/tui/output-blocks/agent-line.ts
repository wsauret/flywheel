import { bold as stBold, fg as stFg, underline as stUnderline, type RGBA, type TextChunk } from "@opentui/core"
import type { ToolPresentation, WorkflowAgentState } from "../../infra/output-blocks.js"
import type { WorkflowAgentDetail } from "../../protocol/client/workflow-card.js"
import type { SubagentLine } from "../../protocol/client/subagent-line.js"
import { workflowAgentGlyph } from "../../protocol/client/workflow-outline.js"
import { chunksWidth, displayWidth, fitChunks } from "../utils/text.js"
import { agentStateColor } from "./workflow-palette.js"

export interface AgentLineTheme {
  readonly text: RGBA
  readonly textMuted: RGBA
  readonly phaseName: RGBA
  readonly agentName: RGBA
  readonly primary: RGBA
  readonly success: RGBA
  readonly error: RGBA
  readonly warning: RGBA
  readonly borderSubtle: RGBA
  readonly chatCodeType: RGBA
}

/** Fits both columns, giving up the sentence before the right-hand time. */
export function spread(left: readonly TextChunk[], right: readonly TextChunk[], width: number, theme: AgentLineTheme): TextChunk[] {
  const rightWidth = chunksWidth(right)
  const shown = fitChunks(left, Math.max(0, width - rightWidth - (rightWidth > 0 ? 1 : 0)))
  return [...shown, stFg(theme.text)(" ".repeat(Math.max(0, width - chunksWidth(shown) - rightWidth))), ...right]
}

export function activityChunks(activity: ToolPresentation, theme: AgentLineTheme): TextChunk[] {
  return [stFg(theme.chatCodeType)(activity.name), stFg(theme.textMuted)(activity.detail === "" ? "" : ` ${activity.detail}`)]
}

export function detailChunks(detail: WorkflowAgentDetail | undefined, theme: AgentLineTheme): TextChunk[] {
  if (detail === undefined) return []
  if (detail.kind === "activity") return activityChunks({ name: detail.tool, detail: detail.text }, theme)
  return [stFg(detail.kind === "reason" ? theme.error : theme.textMuted)(detail.text)]
}

/** A phase or agent identity, with emphasis for running and parked work. */
export function head(state: WorkflowAgentState, role: "phaseName" | "agentName", name: string, width: number, hovered: boolean, theme: AgentLineTheme): TextChunk[] {
  const emphasis = state === "running" || state === "parked"
  const text = stFg(theme[role])(name)
  return [
    stFg(agentStateColor(state, theme))(workflowAgentGlyph(state)),
    stFg(theme.text)(" "),
    hovered ? stUnderline(stBold(text)) : emphasis ? stBold(text) : text,
    stFg(theme.text)(" ".repeat(Math.max(0, width - displayWidth(name)))),
  ]
}

/** The subagent has its identity and time in the header. */
export function subagentLineChunks(line: SubagentLine, width: number, theme: AgentLineTheme): TextChunk[] {
  const color = line.state === "partial" ? theme.warning : agentStateColor(line.state, theme)
  const detail = line.detail?.kind === "state" && line.tone === "warning"
    ? [stFg(theme.warning)(line.detail.text)]
    : line.state === "skipped" && line.detail !== undefined ? [stFg(theme.textMuted)(line.detail.text)] : detailChunks(line.detail, theme)
  return fitChunks([
    stFg(theme.borderSubtle)("└ "),
    stFg(color)(line.glyph),
    stFg(theme.text)(" "),
    ...detail,
  ], width)
}

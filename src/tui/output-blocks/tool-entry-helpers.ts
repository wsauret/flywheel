import { TOOL_PREVIEW_LINE_LIMIT } from "@infra/output-blocks"
import type { FrontendToolEntry } from "../../protocol/app-service-types.js"
import { foldReadRuns, mergeableRead, readRowLabel, type ReadRun } from "../../protocol/client/tool-run-category.js"

type ToolEntryDetailSegment = {
  text: string
  tone?: "error"
}

export type ToolRenderEntry = FrontendToolEntry & {
  /** Native identity when a session message uses a tool disclosure. */
  disclosureId?: string
  detailSegments?: readonly ToolEntryDetailSegment[]
  /** Raw children folded into this row (merged read runs); absent means 1.
   *  The agent-group header uses it to convert shown rows back into raw
   *  operation counts against totalToolCount. */
  rawCount?: number
}

type ToolEntryToggleState = {
  bodyExpanded: boolean
  previewExpanded: boolean
}

type ToolEntryToggleOptions = {
  keepsPreviewVisible: boolean
  previewExpandable: boolean
}

type ToolContentPreview = {
  content: string
  truncated: boolean
  omitted: number
  totalLines: number
}

// Expanded execution output renders in full up to this bound; beyond it the
// tail wins silently (the head of a multi-thousand-line dump carries no
// signal worth a truncation affordance).
const EXECUTION_OUTPUT_TAIL_LIMIT = 1000
// While output is still streaming, every update slides the tail window and
// re-renders every visible line, so the live render is bounded to roughly a
// viewport instead: only the last screenful is observable mid-stream, and the
// full settled tail renders once on completion.
export const LIVE_EXECUTION_OUTPUT_TAIL_LIMIT = 100

export function tailExecutionOutputLines(content: string | undefined, limit = EXECUTION_OUTPUT_TAIL_LIMIT): string[] {
  if (!content) return []
  const lines = content.split("\n")
  return lines.length > limit ? lines.slice(-limit) : lines
}


// Single-target click cycle. Preview-backed entries (body always visible)
// toggle the truncated preview. Hidden-body entries cycle: expand the body,
// then expand truncated preview content, then collapse everything - the
// whole entry is one click target, so preview expansion must be reachable
// from the same click that expands the body.
export function nextToolEntryToggleState(
  state: ToolEntryToggleState,
  options: ToolEntryToggleOptions,
 ): ToolEntryToggleState {
  if (!options.keepsPreviewVisible) {
    if (!state.bodyExpanded) return { bodyExpanded: true, previewExpanded: false }
    if (options.previewExpandable && !state.previewExpanded) return { bodyExpanded: true, previewExpanded: true }
    return { bodyExpanded: false, previewExpanded: false }
  }
  if (!options.previewExpandable) {
    return { ...state, bodyExpanded: true }
  }
  return { bodyExpanded: true, previewExpanded: !state.previewExpanded }
}

export function getToolContentPreview(
  content: string | undefined,
  lineLimit: number = TOOL_PREVIEW_LINE_LIMIT,
 ): ToolContentPreview {
  if (!content) {
    return { content: "", truncated: false, omitted: 0, totalLines: 0 }
  }

  if (lineLimit < 1) {
    const totalLines = countLines(content)
    return { content: "", truncated: totalLines > 0, omitted: totalLines, totalLines }
  }

  let totalLines = 1
  let previewEnd = content.length
  let truncated = false

  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) !== 10) continue
    if (!truncated && totalLines === lineLimit) {
      previewEnd = i
      truncated = true
    }
    totalLines += 1
  }

  return {
    content: truncated ? content.slice(0, previewEnd) : content,
    truncated,
    omitted: truncated ? totalLines - lineLimit : 0,
    totalLines,
  }
}


// Grouped explore aggregation: the shared read-run fold decides which
// consecutive file_read calls merge into one row (the same rule the web
// client applies); this adapter only spells the merged row for the terminal.
// Each argument detail is kept, so a repeated file with different line ranges
// shows each range and the row explains why the agent read it twice. A failed
// read keeps its own error message inline (red), so later labels append after
// it normally.
export function mergeExploreReadRuns(children: readonly FrontendToolEntry[]): ToolRenderEntry[] {
  return foldReadRuns(children).map((row) => {
    if (row.kind === "readRun") return readRunRenderEntry(row.members, row.status, row.errorMessage)
    // A lone failed read reads as concisely as a merged one: its label, then
    // the failure, instead of the raw error after a path the row already shows.
    if (row.status === "error" && mergeableRead(row)) return readRunRenderEntry([row], "error", row.errorMessage)
    return row
  })
}

function readRunRenderEntry(members: readonly FrontendToolEntry[], status: ReadRun["status"], errorMessage: string | undefined): ToolRenderEntry {
  const first = members[0]
  if (!first) throw new Error("a read run has at least one member")
  const detailSegments: ToolEntryDetailSegment[] = []
  for (const member of members) {
    if (detailSegments.length > 0) detailSegments.push({ text: ", " })
    detailSegments.push({ text: readRowLabel(member) })
    if (member.status === "error") detailSegments.push({ text: " " }, { text: member.errorMessage, tone: "error" })
  }
  const base = {
    kind: "tool" as const,
    id: first.id,
    name: first.name,
    presentation: { name: first.presentation.name, detail: detailSegments.map((segment) => segment.text).join("") },
    timestamp: first.timestamp,
    rawCount: members.length,
    detailSegments,
  }
  if (status === "error") return { ...base, status, errorMessage: errorMessage ?? "" }
  return { ...base, status: status === "active" ? "streaming" : status }
}

function countLines(content: string): number {
  let totalLines = 1
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) totalLines += 1
  }
  return totalLines
}

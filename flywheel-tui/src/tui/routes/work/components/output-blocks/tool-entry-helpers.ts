import type { ToolEntry } from "@infra/output-blocks"
import { canonicalize } from "@infra/canonical-name.js"

type ToolContentRenderTarget = Pick<ToolEntry, "name" | "filePath" | "filetype">
type GroupedToolRenderTarget = Pick<ToolEntry, "diff" | "content">

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

export const TOOL_PREVIEW_LINE_LIMIT = 20

export function nextToolEntryToggleState(
  state: ToolEntryToggleState,
  options: ToolEntryToggleOptions,
 ): ToolEntryToggleState {
  if (!options.keepsPreviewVisible) {
    return { ...state, bodyExpanded: !state.bodyExpanded }
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

export function shouldRenderToolContentAsMarkdown(target: ToolContentRenderTarget): boolean {
  if (canonicalize(target.name) !== "write") return false
  const filePath = target.filePath?.trim().toLowerCase()
  if (filePath) return filePath.endsWith(".md")
  return target.filetype?.toLowerCase() === "markdown"
}

export function shouldRenderGroupedToolAsEntry(target: GroupedToolRenderTarget): boolean {
  return typeof target.diff === "string" || typeof target.content === "string"
}

function countLines(content: string): number {
  let totalLines = 1
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) totalLines += 1
  }
  return totalLines
}
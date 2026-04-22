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

export function shouldRenderToolContentAsMarkdown(target: ToolContentRenderTarget): boolean {
  if (canonicalize(target.name) !== "write") return false
  const filePath = target.filePath?.trim().toLowerCase()
  if (filePath) return filePath.endsWith(".md")
  return target.filetype?.toLowerCase() === "markdown"
}

export function shouldRenderGroupedToolAsEntry(target: GroupedToolRenderTarget): boolean {
  return typeof target.diff === "string" || typeof target.content === "string"
}
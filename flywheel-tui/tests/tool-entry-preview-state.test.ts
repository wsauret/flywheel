import { describe, expect, it } from "bun:test"
import {
  getToolContentPreview,
  TOOL_PREVIEW_LINE_LIMIT,
  nextToolEntryToggleState,
} from "../src/tui/routes/work/components/output-blocks/tool-entry-helpers.js"

describe("tool entry preview state", () => {
  it("uses a 20-line preview limit for edit and write previews", () => {
    expect(TOOL_PREVIEW_LINE_LIMIT).toBe(20)
  })

  it("builds a truncated preview with omitted line counts", () => {
    const lines = Array.from({ length: TOOL_PREVIEW_LINE_LIMIT + 2 }, (_, i) => `line ${i + 1}`)
    const preview = getToolContentPreview(lines.join("\n"))

    expect(preview.content).toBe(lines.slice(0, TOOL_PREVIEW_LINE_LIMIT).join("\n"))
    expect(preview.truncated).toBe(true)
    expect(preview.omitted).toBe(2)
    expect(preview.totalLines).toBe(TOOL_PREVIEW_LINE_LIMIT + 2)
  })

  it("counts trailing blank lines when truncating previews", () => {
    expect(getToolContentPreview("line 1\n", 1)).toEqual({
      content: "line 1",
      truncated: true,
      omitted: 1,
      totalLines: 2,
    })
  })

  it("keeps non-truncated previews intact", () => {
    expect(getToolContentPreview("line 1\nline 2", 5)).toEqual({
      content: "line 1\nline 2",
      truncated: false,
      omitted: 0,
      totalLines: 2,
    })
  })

  it("expands preview-backed entries instead of hiding them", () => {
    expect(nextToolEntryToggleState(
      { bodyExpanded: true, previewExpanded: false },
      { keepsPreviewVisible: true, previewExpandable: true },
    )).toEqual({ bodyExpanded: true, previewExpanded: true })
  })

  it("collapses expanded previews back to the truncated preview", () => {
    expect(nextToolEntryToggleState(
      { bodyExpanded: true, previewExpanded: true },
      { keepsPreviewVisible: true, previewExpandable: true },
    )).toEqual({ bodyExpanded: true, previewExpanded: false })
  })

  it("keeps non-truncated previews visible", () => {
    expect(nextToolEntryToggleState(
      { bodyExpanded: false, previewExpanded: false },
      { keepsPreviewVisible: true, previewExpandable: false },
    )).toEqual({ bodyExpanded: true, previewExpanded: false })
  })

  it("still fully toggles non-preview bodies", () => {
    expect(nextToolEntryToggleState(
      { bodyExpanded: true, previewExpanded: false },
      { keepsPreviewVisible: false, previewExpandable: false },
    )).toEqual({ bodyExpanded: false, previewExpanded: false })
  })
})
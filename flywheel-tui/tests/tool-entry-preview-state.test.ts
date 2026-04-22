import { describe, expect, it } from "bun:test"
import {
  TOOL_PREVIEW_LINE_LIMIT,
  nextToolEntryToggleState,
} from "../src/tui/routes/work/components/output-blocks/tool-entry-helpers.js"

describe("tool entry preview state", () => {
  it("uses a 20-line preview limit for edit and write previews", () => {
    expect(TOOL_PREVIEW_LINE_LIMIT).toBe(20)
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

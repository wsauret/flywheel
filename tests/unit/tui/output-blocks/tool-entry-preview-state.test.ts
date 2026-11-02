import { describe, expect, it } from "bun:test"
import { TextAttributes } from "@opentui/core"
import { TOOL_PREVIEW_LINE_LIMIT } from "../../../../src/infra/output-blocks.js"
import { resolveToolPresentation } from "../../../../src/infra/tools/tool-display-registry.js"
import {
  getToolContentPreview,
  nextToolEntryToggleState,
} from "../../../../src/tui/output-blocks/tool-entry-helpers.js"
import { renderToolEntry } from "./_tool-entry-render.js"

const CWD = "/workspace"

describe("tool entry preview state", () => {
  it.each([
    ["pending", { status: "pending" } as const, true, false],
    ["streaming", { status: "streaming" } as const, true, false],
    ["completed", { status: "completed" } as const, false, false],
    ["created result", { status: "completed", resultAction: "created" } as const, false, false],
    ["updated result", { status: "completed", resultAction: "updated" } as const, false, false],
    ["error", { status: "error", errorMessage: "Sanitized skill failure" } as const, false, false],
    ["blocked", { status: "blocked", statusMessage: "Sanitized wait state" } as const, false, false],
    ["interrupted", { status: "interrupted" } as const, false, false],
    ["pending after interruption", { status: "pending" } as const, false, true],
    ["streaming after interruption", { status: "streaming" } as const, false, true],
  ] as const)("keeps the canonical Save Skill presentation and activity marker while %s", async (_label, outcome, active, interrupted) => {
    const result = await renderToolEntry({
      kind: "tool",
      id: "skill-save",
      name: "skill_manage",
      presentation: resolveToolPresentation("skill_manage", { action: "save", name: "snowflake-cli-query" }, CWD),
      timestamp: Date.now(),
      ...outcome,
    }, { interrupted })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("Save Skill snowflake-cli-query")
      const marker = result.captureSpans().lines[0]?.spans[0]
      expect(marker?.text).toMatch(active ? /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/ : /^•$/)
      expect((marker?.attributes ?? 0) & (TextAttributes.BLINK | TextAttributes.DIM)).toBe(0)
      for (const rewritten of ["Saved skill", "Created", "Updated", "Manage skill", "Failed to save", "Waiting to save", "Interrupted while saving"]) {
        expect(frame).not.toContain(rewritten)
      }
    } finally {
      result.renderer.destroy()
    }
  })

  it("appends the failure text after the unchanged memory presentation", async () => {
    const result = await renderToolEntry({
      kind: "tool",
      id: "memory-failed",
      name: "memory",
      presentation: resolveToolPresentation("memory", { action: "add", title: "Use Bun for project scripts" }, CWD),
      status: "error",
      errorMessage: "Memory limit reached",
      timestamp: Date.now(),
    })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("Add Memory Use Bun for project scripts Memory limit reached")
      expect(frame).not.toContain("Failed to add")
      expect(frame).not.toContain("Added new memory")
    } finally {
      result.renderer.destroy()
    }
  })

  it("appends the wait-state text after the unchanged skill-read presentation", async () => {
    const result = await renderToolEntry({
      kind: "tool",
      id: "skill-load-blocked",
      name: "skill",
      presentation: resolveToolPresentation("skill", { action: "load", skill_id: "implementation" }, CWD),
      status: "blocked",
      statusMessage: "Waiting on approval",
      timestamp: Date.now(),
    })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("Load Skill implementation Waiting on approval")
      expect(frame).not.toContain("Loaded skill")
      expect(frame).not.toContain("Waiting to load")
    } finally {
      result.renderer.destroy()
    }
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

  it("cycles hidden-body entries: expand body, expand preview, collapse", () => {
    const options = { keepsPreviewVisible: false, previewExpandable: true }
    const opened = nextToolEntryToggleState({ bodyExpanded: false, previewExpanded: false }, options)
    expect(opened).toEqual({ bodyExpanded: true, previewExpanded: false })
    const fullContent = nextToolEntryToggleState(opened, options)
    expect(fullContent).toEqual({ bodyExpanded: true, previewExpanded: true })
    expect(nextToolEntryToggleState(fullContent, options)).toEqual({ bodyExpanded: false, previewExpanded: false })
  })

})

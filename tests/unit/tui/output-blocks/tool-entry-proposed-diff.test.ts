import { describe, expect, it } from "bun:test"
import { createSignal } from "solid-js"
import { TOOL_PREVIEW_LINE_LIMIT, type ToolEntry as ToolEntryType } from "../../../../src/infra/output-blocks.js"
import { resolveToolPresentation } from "../../../../src/infra/tools/tool-display-registry.js"
import { renderToolEntry } from "./_tool-entry-render.js"
import { writeEntry } from "./_write-entry-fixture.js"
import { mutationEvidenceFixture } from "./_mutation-evidence-fixture.js"
import { buildMutationDiff } from "../../../../src/infra/mutation-diff.js"

function provisionalFileEntry(path?: string): ToolEntryType {
  return {
    kind: "tool",
    id: "streaming-write",
    name: "write",
    presentation: resolveToolPresentation("write", { path: path ?? "" }, "/workspace"),
    status: "streaming",
    fileChangeKind: "create",
    proposedDiff: {
      files: [{
        id: "file-0",
        ...(path === undefined ? {} : { path }),
        action: "add",
        hunks: [{
          id: "hunk-0",
          newStart: 1,
          omittedBefore: 0,
          omittedAfter: 0,
          lines: Array.from({ length: TOOL_PREVIEW_LINE_LIMIT + 2 }, (_, index) => ({
            id: `line-${index}`,
            kind: "add" as const,
            text: `const value${index} = ${index}`,
            partial: false,
          })),
        }],
      }],
    },
    timestamp: Date.now(),
  }
}

describe("tool entry proposed diff", () => {
  it("keeps file disclosure through proposal path arrival and canonical replacement", async () => {
    const content = Array.from({ length: 22 }, (_, index) => `const value${index} = ${index}`).join("\n")
    const fixture = await mutationEvidenceFixture(buildMutationDiff([{
      path: "src/created.ts", before: { kind: "absent" }, after: { kind: "text", text: content },
    }]))
    const [block, setBlock] = createSignal<ToolEntryType>(provisionalFileEntry())
    const result = await renderToolEntry(block, { height: 64, evidenceReader: fixture.reader })
    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Proposed changes")
      expect(result.captureCharFrame()).toContain("... +2 lines (click to expand)")

      await result.mockMouse.click(8, 0)
      setBlock(provisionalFileEntry("src/created.ts"))
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("const value21 = 21")

      const completed = writeEntry(content, { path: "src/created.ts" })
      setBlock({ ...completed, id: "streaming-write", fileChangeKind: "create", mutationEvidence: fixture.evidence })
      for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
      const frame = result.captureCharFrame()
      expect(frame).not.toContain("Proposed changes")
      expect(frame).toContain("const value21 = 21")
      expect(frame).not.toContain("... +2 lines (click to expand)")
      expect(frame.match(/const value21 = 21/g)).toHaveLength(1)
    } finally {
      result.renderer.destroy()
      fixture.reader.dispose()
    }
  })

  it("retires a wrapping proposal's header chevron when a short actual diff replaces it", async () => {
    const fixture = await mutationEvidenceFixture(buildMutationDiff([{
      path: "src/created.ts", before: { kind: "absent" }, after: { kind: "text", text: "const short = 1" },
    }]))
    const proposal = provisionalFileEntry("src/created.ts")
    const wrapping: ToolEntryType = { ...proposal, proposedDiff: { files: proposal.proposedDiff!.files.map(file => ({
      ...file, hunks: file.hunks.map(hunk => ({ ...hunk, lines: [{ id: "line-0", kind: "add" as const, text: "wrapped ".repeat(400), partial: false }] })),
    })) } }
    const [block, setBlock] = createSignal<ToolEntryType>(wrapping)
    const result = await renderToolEntry(block, { height: 64, evidenceReader: fixture.reader })
    try {
      await result.renderOnce()
      await result.renderOnce()
      expect(result.captureCharFrame().split("\n")[0]).toContain("▸")
      const completed = writeEntry("const short = 1", { path: "src/created.ts" })
      setBlock({ ...completed, id: "streaming-write", fileChangeKind: "create", mutationEvidence: fixture.evidence })
      for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
      const lines = result.captureCharFrame().split("\n")
      expect(lines.join("\n")).toContain("const short = 1")
      expect(lines[0]).not.toMatch(/[▸▾]/)
    } finally {
      result.renderer.destroy()
      fixture.reader.dispose()
    }
  })

  it("renders a failed file proposal as summary and error only", async () => {
    const result = await renderToolEntry({
      ...provisionalFileEntry("src/failed.ts"),
      status: "error",
      errorMessage: "write failed",
      content: "raw syntax body must not render",
    }, { height: 64 })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("Write src/failed.ts write failed")
      expect(frame).not.toContain("Proposed changes")
      expect(frame).not.toContain("const value0 = 0")
      expect(frame).not.toContain("const value21 = 21")
      expect(frame).not.toContain("raw syntax body must not render")
      expect(frame).not.toContain("▸")
    } finally {
      result.renderer.destroy()
    }
  })

  it("replaces a proposed diff with a compact preview advisory", async () => {
    const block = provisionalFileEntry("src/advised.ts")
    const result = await renderToolEntry(block, {
      height: 64,
      streamingToolText: {
        "streaming-write": {
          previewCheck: "Expected a closing brace",
        },
      },
    })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("Preview check: Expected a closing brace")
      expect(frame).not.toContain("Proposed changes")
      expect(frame).not.toContain("const value0 = 0")
      expect(frame).not.toContain("▸")
    } finally {
      result.renderer.destroy()
    }
  })
})

import { describe, expect, it, mock } from "bun:test"
import type { ToolEntry as ToolEntryType } from "../../../../src/infra/output-blocks.js"
import { resolveToolPresentation } from "../../../../src/infra/tools/tool-display-registry.js"
import { createBlockDisclosureChannel } from "../../../../src/tui/context/block-disclosure.js"
import flywheelThemeJson from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"
import { createSignal } from "solid-js"
import { editDiff } from "./_edit-diff-fixture.js"
import { mutationEvidenceFixture } from "./_mutation-evidence-fixture.js"
import { renderToolEntry, restingFrameLines, settledFrameLines } from "./_tool-entry-render.js"

const CWD = "/workspace"
const theme = resolveTheme(flywheelThemeJson, "dark")

async function canonicalMultiFileEditEntry() {
  const patchInput = "@@ src/first.ts\n= 1aa..1aa\n~first\n@@ src/second.ts\n= 1bb..1bb\n~second"
  const fixture = await mutationEvidenceFixture({
    version: 1,
    files: [
      { path: "src/first.ts", change: "modified", unifiedDiff: editDiff() },
      { path: "src/second.ts", change: "modified", unifiedDiff: editDiff() },
    ],
    omissions: [],
  })
  const block: ToolEntryType = {
    kind: "tool",
    id: "edit-many",
    name: "edit",
    presentation: resolveToolPresentation("edit", { input: patchInput }, CWD),
    status: "completed",
    fileChangeKind: "patch",
    mutationEvidence: fixture.evidence,
    timestamp: Date.now(),
  }
  return { block, fixture }
}

describe("tool entry multi-file disclosure", () => {
  it("gives each file in a multi-file edit its own preview and disclosure", async () => {
    const { block, fixture } = await canonicalMultiFileEditEntry()
    const result = await renderToolEntry(block, { height: 96, evidenceReader: fixture.reader })
    try {
      for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
      const collapsed = await restingFrameLines(result)
      expect(collapsed[0]).toBe("• Edit")
      expect(collapsed.filter((line) => line.includes("src/first.ts"))).toHaveLength(1)
      expect(collapsed.filter((line) => line.includes("src/second.ts"))).toHaveLength(1)
      expect(collapsed.filter((line) => line.includes("const filler16 = 16"))).toHaveLength(2)
      expect(collapsed.filter((line) => line.includes("const filler17 = 17"))).toHaveLength(0)
      expect(collapsed.filter((line) => line.includes("... +6 lines (click to expand)"))).toHaveLength(2)

      const rawCollapsed = result.captureCharFrame().split("\n")
      const secondHeadingRow = rawCollapsed.findIndex((line) => line.includes("src/second.ts"))
      expect(secondHeadingRow).toBeGreaterThan(0)
      expect(rawCollapsed[secondHeadingRow - 1]?.trim()).toBe("")

      await result.mockMouse.moveTo(8, secondHeadingRow)
      await result.renderOnce()
      const hovered = result.captureCharFrame().split("\n")
      expect(hovered[secondHeadingRow]).toContain("┃")
      const railSpan = result.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("┃"))
      expect(railSpan?.fg.equals(theme.primary)).toBe(true)

      await result.mockMouse.click(8, secondHeadingRow)
      const expanded = await settledFrameLines(result, fixture)
      expect(expanded.filter((line) => line.includes("const filler22 = 22"))).toHaveLength(1)
      expect(expanded.filter((line) => line.includes("... +6 lines (click to expand)"))).toHaveLength(1)
      expect(expanded.filter((line) => line.includes("(click to collapse)"))).toHaveLength(1)

      // The space beside a file heading is header space and leaves the file as
      // it is; the space after a short line of the file's body collapses only
      // that file, inside the tool body that encloses it.
      await result.mockMouse.click(60, secondHeadingRow)
      expect((await settledFrameLines(result, fixture)).filter((line) => line.includes("const filler22 = 22"))).toHaveLength(1)
      const shortLine = result.captureCharFrame().split("\n").findLastIndex((line) => line.includes("const filler22 = 22"))
      await result.mockMouse.click(60, shortLine)
      const collapsedAgain = await settledFrameLines(result, fixture)
      expect(collapsedAgain.filter((line) => line.includes("const filler22 = 22"))).toHaveLength(0)
      expect(collapsedAgain.filter((line) => line.includes("... +6 lines (click to expand)"))).toHaveLength(2)
    } finally {
      result.renderer.destroy(); fixture.reader.dispose()
    }
  })

  it("restores one file's disclosure after the tool row remounts", async () => {
    const disclosure = createBlockDisclosureChannel()
    const { block, fixture } = await canonicalMultiFileEditEntry()
    const first = await renderToolEntry(block, { height: 96, disclosure, evidenceReader: fixture.reader })
    try {
      for (let frame = 0; frame < 3; frame++) { await first.renderOnce(); await fixture.settle() }
      const rows = first.captureCharFrame().split("\n")
      const secondHeadingRow = rows.findIndex((line) => line.includes("src/second.ts"))
      await first.mockMouse.click(8, secondHeadingRow)
      expect((await settledFrameLines(first, fixture)).filter((line) => line.includes("const filler22 = 22"))).toHaveLength(1)
    } finally {
      first.renderer.destroy()
    }

    const remounted = await renderToolEntry(block, { height: 96, disclosure, evidenceReader: fixture.reader })
    try {
      const restored = await settledFrameLines(remounted, fixture)
      expect(restored.filter((line) => line.includes("const filler22 = 22"))).toHaveLength(1)
      expect(restored.filter((line) => line.includes("... +6 lines (click to expand)"))).toHaveLength(1)
      expect(restored.filter((line) => line.includes("(click to collapse)"))).toHaveLength(1)
    } finally {
      remounted.renderer.destroy(); fixture.reader.dispose()
    }
  })

  it("keeps only the selected file expanded when its row is repaved with the same manifest", async () => {
    const { block: initial, fixture } = await canonicalMultiFileEditEntry()
    const [block, setBlock] = createSignal<ToolEntryType>(initial)
    const hydrate = mock((_blockId: string) => {})
    const result = await renderToolEntry(block, { height: 96, onHydrateBody: hydrate, evidenceReader: fixture.reader })
    try {
      for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
      const rows = result.captureCharFrame().split("\n")
      const secondHeadingRow = rows.findIndex((line) => line.includes("src/second.ts"))
      await result.mockMouse.click(8, secondHeadingRow)
      setBlock({ ...initial, mutationEvidence: { ...fixture.evidence, manifest: { ...fixture.evidence.manifest } } })
      const hydrated = await settledFrameLines(result, fixture)
      expect(hydrate).not.toHaveBeenCalled()
      expect(hydrated.filter((line) => line.includes("const filler22 = 22"))).toHaveLength(1)
      expect(hydrated.filter((line) => line.includes("... +6 lines (click to expand)"))).toHaveLength(1)
      expect(hydrated.filter((line) => line.includes("(click to collapse)"))).toHaveLength(1)
    } finally {
      result.renderer.destroy(); fixture.reader.dispose()
    }
  })

  it("renders stored historical replace calls generically", async () => {
    const { block: initial, fixture } = await canonicalMultiFileEditEntry()
    const block = {
      ...initial,
      fileChangeKind: undefined,
      id: "replace-many",
      name: "replace",
      presentation: resolveToolPresentation("replace", { files: ["src/first.ts", "src/second.ts"] }, CWD),
    }
    const result = await renderToolEntry(block, { height: 64, evidenceReader: fixture.reader })
    try {
      await result.renderOnce()
      const collapsed = await restingFrameLines(result)
      expect(collapsed).toEqual(["• replace ▸"])
    } finally {
      result.renderer.destroy(); fixture.reader.dispose()
    }
  })
})

import { afterEach, describe, expect, it, mock } from "bun:test"
import type { ToolEntry as ToolEntryType } from "../../../../src/infra/output-blocks.js"
import { TOOL_PREVIEW_LINE_LIMIT } from "../../../../src/infra/output-blocks.js"
import { resolveToolPresentation } from "../../../../src/infra/tools/tool-display-registry.js"
import { createBlockDisclosureChannel, fileDisclosureKey } from "../../../../src/tui/context/block-disclosure.js"
import flywheelThemeJson from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"
import { renderToolEntry, restingFrameLines, settledFrameLines } from "./_tool-entry-render.js"
import { editDiff } from "./_edit-diff-fixture.js"
import { writeEntry } from "./_write-entry-fixture.js"
import { createSignal } from "solid-js"
import { mutationEvidenceFixture } from "./_mutation-evidence-fixture.js"
import { buildMutationDiff } from "../../../../src/infra/mutation-diff.js"
import { TextAttributes } from "@opentui/core"

const CWD = "/workspace"
const theme = resolveTheme(flywheelThemeJson, "dark")
const proposedDiff: NonNullable<ToolEntryType["proposedDiff"]> = {
  files: [{ id: "file-0", path: "sanitized-example.ts", action: "update",
    hunks: [{ id: "hunk-0", oldStart: 1, newStart: 1, omittedBefore: 0, omittedAfter: 0,
      lines: [{ id: "row-0", kind: "add", text: "const proposed = 2", partial: false }] }] }],
}

afterEach(() => { mock.restore() })

it("retains one disclosure cell through path arrival and canonical file omissions", () => {
  const disclosure = createBlockDisclosureChannel()
  const first = { id: "file-0", path: "" }
  const key = fileDisclosureKey(disclosure, "tool", first)
  disclosure.setDisclosure(key, true)
  expect(fileDisclosureKey(disclosure, "tool", { ...first, path: "a.ts" })).toBe(key)
  expect(disclosure.disclosure(fileDisclosureKey(disclosure, "tool", { id: "b.ts", path: "b.ts" }))).toBeUndefined()
  const actual = fileDisclosureKey(disclosure, "tool", { id: "a.ts", path: "a.ts" })
  expect(disclosure.disclosure(actual)).toBe(true)
  disclosure.setDisclosure(actual, false)
  expect(disclosure.disclosure(key)).toBe(false)
  const single = fileDisclosureKey(disclosure, "write", first, true)
  disclosure.setDisclosure(single, true)
  expect(fileDisclosureKey(disclosure, "write", { id: "new.ts", path: "new.ts" }, true)).toBe(single)
})

async function renderWriteEntry(content: string): Promise<string> {
  const block = writeEntry(content)
  const fixture = await mutationEvidenceFixture(buildMutationDiff([{ path: "example.ts", before: { kind: "absent" }, after: { kind: "text", text: content } }]))
  const result = await renderToolEntry({ ...block, fileChangeKind: "create", content: undefined, mutationEvidence: fixture.evidence }, { evidenceReader: fixture.reader })
  try {
    for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
    return result.captureCharFrame()
  } finally {
    result.renderer.destroy(); fixture.reader.dispose()
  }
}

/** Two-hunk unified diff whose hunk content lines exceed the preview budget.
 *  The structural lines (file headers, `@@` hunk headers) are deliberate: the
 *  renderer must never count or show them. */
function editEntry(): ToolEntryType {
  return {
    kind: "tool",
    id: "edit-1",
    name: "edit",
    presentation: resolveToolPresentation("edit", { path: "src/sanitized-example.ts" }, CWD),
    // Production edit rows carry the file link that abbreviates the path.
    linkUri: `file://${CWD}/src/sanitized-example.ts`,
    status: "completed",
    diff: editDiff(),
    filetype: "typescript",
    timestamp: Date.now(),
  }
}

/** Gutter rows the collapsed and expanded edit frames share: hunk two starts at
 *  new-file line 10, so filler N renders under line number 10 + N. */
function fillerRows(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `     ${10 + index}  const filler${index} = ${index}`)
}

/** A memory write: the artifact rides `mutation`, not the legacy per-tool
 *  `diff`. Its patch is the edit fixture, so the rendered rows are directly
 *  comparable with the edit frames above. */
function memoryEntry(): ToolEntryType {
  return {
    kind: "tool",
    id: "memory-write",
    name: "memory",
    presentation: resolveToolPresentation("memory", { action: "add", title: "Use Bun for project scripts" }, CWD),
    status: "completed",
    timestamp: Date.now(),
  }
}

describe("tool entry mutation rendering", () => {
  it("pages metadata previews, preserves styled rails, and reads bytes only after expansion", async () => {
    const patch = editDiff(60)
    const fixture = await mutationEvidenceFixture(Array.from({ length: 12 }, (_, index) => ({
      path: `src/${["first", "second", "third"][index] ?? `file${index}`}.ts`, patch, lines: 60,
    })), { windowBytes: 100, pageFiles: 2 })
    const result = await renderToolEntry({ ...editEntry(), fileChangeKind: "patch", diff: undefined, mutationEvidence: fixture.evidence }, {
      height: 32, evidenceReader: fixture.reader, scroll: true,
    })
    try {
      for (let frame = 0; frame < 12; frame++) { await result.renderOnce(); await fixture.settle() }
      const collapsed = await restingFrameLines(result)
      expect(collapsed.some(line => line.includes("src/first.ts (update)"))).toBe(true)
      expect(collapsed.some(line => line.includes("const first = 1"))).toBe(true)
      const metadataReads = fixture.calls.filter(call => call.type === "mutationFiles").length
      expect(metadataReads).toBeGreaterThan(1)
      expect(metadataReads).toBeLessThan(6)
      const held = fixture.reader.open("tool:edit-1", fixture.evidence.manifest)
      const first = fixture.entries[0]!
      // Collapsed files render their page previews and read no patch bytes.
      expect(fixture.calls.filter(call => call.type === "mutationPatchWindow")).toHaveLength(0)
      const reads = fixture.calls.length
      for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
      expect(fixture.calls).toHaveLength(reads)
      const removed = result.captureSpans().lines.find(line => line.spans.map(span => span.text).join("").includes("-const second"))
      expect(removed?.spans.some(span => span.bg?.equals(theme.diffRemovedBg))).toBe(true)
      expect(removed?.spans.some(span => span.bg?.equals(theme.diffHighlightRemoved))).toBe(true)
      const added = result.captureSpans().lines.find(line => line.spans.map(span => span.text).join("").includes("+const second"))
      expect(added?.spans.some(span => span.bg?.equals(theme.diffHighlightAdded))).toBe(true)
      expect(result.captureSpans().lines.flatMap(line => line.spans).every(span => (span.attributes & TextAttributes.BLINK) === 0)).toBe(true)
      const heading = result.captureCharFrame().split("\n").findIndex(line => line.includes("src/first.ts"))
      await result.mockMouse.moveTo(8, heading)
      await result.renderOnce()
      const rail = result.captureSpans().lines.flatMap(line => line.spans).find(span => span.text.includes("┃"))
      expect(rail?.fg.equals(theme.primary)).toBe(true)
      await result.mockMouse.click(8, heading)
      for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
      const firstBytes = held.patch(first)!.view.text.length
      expect(firstBytes).toBeGreaterThan(0)
      expect(firstBytes).toBeLessThan(patch.length)
      expect(result.captureCharFrame()).toContain("const filler17")
      await result.mockMouse.click(8, heading)
      await result.renderOnce()
      for (let scroll = 0; scroll < 4; scroll++) {
        result.scrollTo(1000)
        for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
      }
      expect(fixture.calls.filter(call => call.type === "mutationFiles")).toHaveLength(6)
      const patchReads = fixture.calls.filter(call => call.type === "mutationPatchWindow").length
      result.scrollTo(1000)
      for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
      expect(fixture.calls.filter(call => call.type === "mutationPatchWindow")).toHaveLength(patchReads)
      expect(result.captureCharFrame()).toContain("const filler16 = 16")
    } finally { result.renderer.destroy(); fixture.reader.dispose() }
  })

  it("continues an expanded byte prefix while scrolling inside one long logical line", async () => {
    const fixture = await mutationEvidenceFixture([{ path: "long.ts", lines: 1,
      patch: `--- /dev/null\n+++ b/long.ts\n@@ -0,0 +1 @@\n+${"x".repeat(12_000)}\n`,
    }], { windowBytes: 600 })
    const result = await renderToolEntry({ ...editEntry(), fileChangeKind: "patch", diff: undefined, mutationEvidence: fixture.evidence }, {
      height: 32, width: 80, evidenceReader: fixture.reader, scroll: true,
    })
    try {
      for (let frame = 0; frame < 4; frame++) { await result.renderOnce(); await fixture.settle() }
      const patch = fixture.reader.open("tool:edit-1", fixture.evidence.manifest).patch(fixture.entries[0]!)!
      // A collapsed line wraps from the page preview to the preview rows, with no byte read.
      expect(patch.view.text.length).toBe(0)
      expect(result.captureCharFrame().split("\n").filter(line => line.includes("xxxxxxxx"))).toHaveLength(20)
      await result.mockMouse.click(4, 0)
      for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
      const expandedBytes = patch.view.text.length
      expect(expandedBytes).toBeGreaterThan(0)
      result.scrollTo(1000)
      for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
      expect(patch.view.text.length).toBeGreaterThan(expandedBytes)
      expect(patch.view.complete).toBe(false)
      expect(result.captureCharFrame()).toContain("xxxxxxxxxxxxxxxx")
    } finally { result.renderer.destroy(); fixture.reader.dispose() }
  })

  it.each(["missing", "corrupt", "no-reader"] as const)("states %s stored bytes as unavailable without falling back to a proposal", async failure => {
    const fixture = await mutationEvidenceFixture([{ path: "sanitized-example.ts", patch: editDiff(), lines: 26 }])
    if (failure !== "no-reader") fixture.failPatches(failure)
    const result = await renderToolEntry({ ...editEntry(), fileChangeKind: "patch", diff: undefined, proposedDiff, mutationEvidence: fixture.evidence }, {
      height: 32, evidenceReader: failure === "no-reader" ? undefined : fixture.reader,
    })
    try {
      for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
      expect(result.captureCharFrame()).toContain("Change evidence is unavailable")
      expect(result.captureCharFrame()).not.toContain("Proposed changes")
      const unavailableSpan = result.captureSpans().lines.flatMap(line => line.spans).find(span => span.text.includes("Change evidence is unavailable"))
      expect(unavailableSpan?.fg.equals(theme.textMuted)).toBe(true)
    } finally { result.renderer.destroy(); fixture.reader.dispose() }
  })

  it("clears a pending proposal on settlement before its metadata page arrives", async () => {
    const fixture = await mutationEvidenceFixture([{ path: "sanitized-example.ts", patch: editDiff(), lines: 26 }], { windowBytes: 180 })
    const gate = Promise.withResolvers<void>()
    fixture.holdFiles(gate.promise)
    const [block, setBlock] = createSignal<ToolEntryType>({ ...editEntry(), status: "pending", fileChangeKind: "patch", diff: undefined, proposedDiff })
    const result = await renderToolEntry(block, { height: 32, evidenceReader: fixture.reader })
    try {
      await result.renderOnce()
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Proposed changes")
      expect(result.captureCharFrame()).toContain("const proposed = 2")
      expect(result.captureCharFrame()).not.toContain("const first = 1")
      setBlock({ ...editEntry(), fileChangeKind: "patch", diff: undefined, mutationEvidence: fixture.evidence })
      await result.renderOnce()
      await result.renderOnce()
      expect(result.captureCharFrame()).not.toContain("Proposed changes")
      expect(result.captureCharFrame()).toContain("Loading")
      gate.resolve()
      await fixture.settle()
      for (let frame = 0; frame < 4; frame++) { await result.renderOnce(); await fixture.settle() }
      const actual = result.captureCharFrame()
      expect(actual).not.toContain("Proposed changes")
      expect(actual).not.toContain("const proposed = 2")
      expect(actual.match(/const first = 1/g)).toHaveLength(1)
    } finally { gate.resolve(); result.renderer.destroy(); fixture.reader.dispose() }
  })

  it("keeps learning evidence hidden until disclosure and resident across row remounts", async () => {
    const fixture = await mutationEvidenceFixture([{ path: "USER.md", patch: editDiff(), lines: 26 }])
    const block = { ...memoryEntry(), mutationEvidence: fixture.evidence }
    const disclosure = createBlockDisclosureChannel()
    const first = await renderToolEntry(block, { height: 64, evidenceReader: fixture.reader, disclosure })
    try {
      await first.renderOnce()
      expect(fixture.calls).toHaveLength(0)
      expect(first.captureCharFrame()).not.toContain("const first = 1")
      await first.mockMouse.click(4, 0)
      for (let frame = 0; frame < 4; frame++) { await first.renderOnce(); await fixture.settle() }
      expect(first.captureCharFrame()).toContain("const filler22")
    } finally { first.renderer.destroy() }
    const calls = fixture.calls.length
    const bytes = fixture.reader.heldBytes
    const remount = await renderToolEntry(block, { height: 64, evidenceReader: fixture.reader, disclosure })
    try {
      await remount.renderOnce()
      expect(remount.captureCharFrame()).toContain("const filler22")
      expect(fixture.calls).toHaveLength(calls)
      expect(fixture.reader.heldBytes).toBe(bytes)
    } finally { remount.renderer.destroy(); fixture.reader.dispose() }
  })

  it("does not read omitted sensitive bytes and states unavailable patches inside their file", async () => {
    const fixture = await mutationEvidenceFixture([
      { path: "secrets.env", omission: "sensitive" },
      { path: "missing.ts" },
    ])
    const result = await renderToolEntry({ ...editEntry(), diff: undefined, mutationEvidence: fixture.evidence }, {
      height: 32, evidenceReader: fixture.reader,
    })
    try {
      for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
      expect(result.captureCharFrame()).toContain("secrets.env  (diff omitted: sensitive)")
      expect(result.captureCharFrame()).toContain("Change evidence is unavailable")
      expect(fixture.calls.filter(call => call.type === "mutationPatchWindow")).toHaveLength(0)
      await result.mockMouse.click(8, 2)
      await result.renderOnce()
      expect(fixture.calls.filter(call => call.type === "mutationPatchWindow")).toHaveLength(0)
    } finally { result.renderer.destroy(); fixture.reader.dispose() }
  })

  it("reserves the expanded line-number gutter width in truncated write previews", async () => {
    const content = Array.from({ length: 101 }, (_, i) => `line ${i + 1}`).join("\n")
    const frame = await renderWriteEntry(content)
    const firstContentLine = frame.split("\n").find((line) => line.includes("line 1"))

    expect(firstContentLine).toMatch(/^ {7}1 line 1/)
  })

  it("renders mutation-backed writes as one syntax preview", async () => {
    const content = Array.from({ length: TOOL_PREVIEW_LINE_LIMIT + 2 }, (_, i) => `const line${i + 1} = ${i + 1}`).join("\n")
    const inline = writeEntry(content)
    const fixture = await mutationEvidenceFixture(buildMutationDiff([{ path: "example.ts", before: { kind: "absent" }, after: { kind: "text", text: content } }]))
    const result = await renderToolEntry({ ...inline, fileChangeKind: "create", content: undefined, mutationEvidence: fixture.evidence }, { height: 64, evidenceReader: fixture.reader })
    try {
      for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
      const collapsed = await restingFrameLines(result)
      expect(collapsed).toContain("     20 const line20 = 20")
      expect(collapsed).not.toContain("const line21 = 21")
      expect(collapsed).not.toContain("      example.ts")
      expect(collapsed.some(line => line.includes("+2 lines (click to expand)"))).toBe(true)

      await result.mockMouse.click(4, 0)
      const expanded = await restingFrameLines(result)
      expect(expanded.filter((line) => line.includes("const line20 = 20"))).toHaveLength(1)
      expect(expanded).toContain("     22 const line22 = 22")
      expect(expanded).not.toContain("      example.ts")
    } finally { result.renderer.destroy(); fixture.reader.dispose() }
  })

  it.each(["edit", "write"] as const)("toggles a %s preview from any cell of its body, never from blank header space", async (name) => {
    const after = Array.from({ length: 40 }, (_, index) => index % 5 === 2 ? "" : `const v${index} = ${index}`)
    const before = name === "edit" ? { kind: "text" as const, text: after.map((line) => line.replace("const", "let")).join("\n") } : { kind: "absent" as const }
    const fixture = await mutationEvidenceFixture(buildMutationDiff([{ path: "example.ts", before, after: { kind: "text", text: after.join("\n") } }]))
    const block: ToolEntryType = { ...writeEntry(""), id: name, name, presentation: resolveToolPresentation(name, { path: "example.ts" }, CWD), fileChangeKind: name === "edit" ? "patch" : "create", content: undefined, mutationEvidence: fixture.evidence }
    const result = await renderToolEntry(block, { height: 120, evidenceReader: fixture.reader })
    const expanded = async () => (await settledFrameLines(result, fixture)).some((line) => line.includes("(click to collapse)"))
    try {
      expect(await expanded()).toBe(false)
      const rows = result.captureCharFrame().split("\n")
      const shortLine = rows.findIndex((line) => line.includes("v3 = 3"))
      const blankLine = rows.findIndex((line, row) => row > 1 && line.trim() === "3")
      await result.mockMouse.click(60, shortLine)
      expect(await expanded()).toBe(true)
      await result.mockMouse.click(30, blankLine)
      expect(await expanded()).toBe(false)
      await result.mockMouse.click(70, 0)
      expect(await expanded()).toBe(false)
    } finally {
      result.renderer.destroy(); fixture.reader.dispose()
    }
  })

  it("renders Markdown writes as syntax-highlighted source", async () => {
    const result = await renderToolEntry(writeEntry("# Heading\n\n**bold source**", {
      path: "README.md",
      filetype: "markdown",
    }))
    try {
      await result.renderOnce()
      const content = result.captureCharFrame()
      expect(content).toContain("# Heading")
      expect(content).toContain("**bold source**")
    } finally {
      result.renderer.destroy()
    }
  })

  it("captures the collapsed edit frame: the first 20 hunk lines and the omitted-line affordance", async () => {
    const result = await renderToolEntry(editEntry(), { height: 64 })
    try {
      await result.renderOnce()

      expect(await restingFrameLines(result)).toEqual([
        "• Edit sanitized-example.ts ▸",
        "     1  const first = 1",
        "     2 -const second = 2",
        "     2 +const second = 3",
        ...fillerRows(17),
        "      ... +6 lines (click to expand)",
      ])
    } finally {
      result.renderer.destroy()
    }
  })

  it("captures the expanded edit frame: every hunk line and the collapse affordance", async () => {
    const result = await renderToolEntry(editEntry(), { height: 64 })
    try {
      await result.renderOnce()
      await result.mockMouse.click(4, 0)

      expect(await restingFrameLines(result)).toEqual([
        "• Edit sanitized-example.ts ▾",
        "     1  const first = 1",
        "     2 -const second = 2",
        "     2 +const second = 3",
        ...fillerRows(23),
        "      (click to collapse)",
      ])
    } finally {
      result.renderer.destroy()
    }
  })

  it("keeps a short edit diff whole, with no truncation affordance and no chevron", async () => {
    const result = await renderToolEntry({ ...editEntry(), diff: editDiff(3) }, { height: 64 })
    try {
      await result.renderOnce()

      expect(await restingFrameLines(result)).toEqual([
        "• Edit sanitized-example.ts",
        "     1  const first = 1",
        "     2 -const second = 2",
        "     2 +const second = 3",
      ])
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders no diff body for a failed edit, only its error", async () => {
    const hydrate = mock((_blockId: string) => {})
    const result = await renderToolEntry({
      ...editEntry(),
      fileChangeKind: "replace",
      status: "error",
      errorMessage: "Sanitized tool failure",
      content: "stale raw body",
      diffOmission: { kind: "aggregate", omittedLines: 50 },
    }, { height: 64, onHydrateBody: hydrate })
    try {
      await result.renderOnce()

      expect(await restingFrameLines(result)).toEqual([
        "• Edit sanitized-example.ts Sanitized tool failure",
      ])
      expect(hydrate).not.toHaveBeenCalled()
    } finally {
      result.renderer.destroy()
    }
  })

  it("keeps the diff body for every non-error edit outcome", async () => {
    const outcomes: ToolEntryType[] = [
      { ...editEntry(), status: "interrupted" },
      { ...editEntry(), status: "blocked", statusMessage: "Sanitized wait state" },
      { ...editEntry(), status: "pending" },
    ]
    for (const block of outcomes) {
      const result = await renderToolEntry(block, { height: 64 })
      try {
        await result.renderOnce()
        const lines = await restingFrameLines(result)

        expect(lines, block.status).toContain("     2 +const second = 3")
        expect(lines, block.status).toContain("      ... +6 lines (click to expand)")
      } finally {
        result.renderer.destroy()
      }
    }
  })

  it("renders no diff body for a header-only edit diff that parses to no hunk lines", async () => {
    const result = await renderToolEntry({ ...editEntry(), diff: "--- a/src/sanitized-example.ts\n+++ b/src/sanitized-example.ts" }, { height: 64 })
    try {
      await result.renderOnce()

      expect(await restingFrameLines(result)).toEqual([
        "• Edit sanitized-example.ts",
      ])
    } finally {
      result.renderer.destroy()
    }
  })

  it("adds wire-omitted lines to the edit truncation affordance and hydrates the full diff only on expand", async () => {
    const hydrate = mock((_blockId: string) => {})
    const wireDiff = editDiff().split("\n").slice(0, 24).join("\n")
    const result = await renderToolEntry({ ...editEntry(), diff: wireDiff, diffOmission: { kind: "aggregate", omittedLines: 6 } }, {
      height: 64,
      onHydrateBody: hydrate,
    })
    try {
      await result.renderOnce()
      expect(await restingFrameLines(result)).toEqual([
        "• Edit sanitized-example.ts ▸",
        "     1  const first = 1",
        "     2 -const second = 2",
        "     2 +const second = 3",
        ...fillerRows(17),
        "      ... +6 lines (click to expand)",
      ])
      expect(hydrate).not.toHaveBeenCalled()

      await result.mockMouse.click(4, 0)
      const expanded = await restingFrameLines(result)
      expect(expanded).toContain("      (click to collapse)")
      expect(expanded).not.toContain("     32  const filler22 = 22")
      expect(hydrate).toHaveBeenCalledTimes(1)
      expect(hydrate).toHaveBeenCalledWith("tool:edit-1")
    } finally {
      result.renderer.destroy()
    }
  })

  it("reads converted display evidence without whole-body hydration", async () => {
    const hydrate = mock((_blockId: string) => {})
    const fixture = await mutationEvidenceFixture({ version: 1, files: [{ path: "src/first.ts", change: "modified", unifiedDiff: editDiff() }], omissions: [] })
    const result = await renderToolEntry({
      ...editEntry(), id: "edit-many", diff: undefined, fileChangeKind: "patch",
      presentation: resolveToolPresentation("edit", { path: "src/first.ts" }, CWD),
      mutationEvidence: fixture.evidence,
    }, { height: 64, onHydrateBody: hydrate, evidenceReader: fixture.reader })
    try {
      for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
      const collapsed = await restingFrameLines(result)
      expect(collapsed[0]).toBe("• Edit first.ts ▸")
      expect(collapsed.some((line) => line.trim() === "src/first.ts")).toBe(false)
      expect(collapsed.join("\n")).toContain("+6 lines")
      expect(hydrate).not.toHaveBeenCalled()

      await result.mockMouse.click(4, 0)
      await restingFrameLines(result)
      expect(hydrate).not.toHaveBeenCalled()
    } finally {
      result.renderer.destroy(); fixture.reader.dispose()
    }
  })

  it.each([
    ["note creation", { ...memoryEntry(), id: "note-create", name: "note_write", presentation: resolveToolPresentation("note_write", { path: "checkpoint.md" }, CWD), mutation: { version: 1 as const, files: [{ path: "checkpoint.md", change: "added" as const, unifiedDiff: editDiff() }], omissions: [] } }, "checkpoint.md"],
    ["note append", { ...memoryEntry(), id: "note-append", name: "note_append", presentation: resolveToolPresentation("note_append", { path: "checkpoint.md" }, CWD), mutation: { version: 1 as const, files: [{ path: "checkpoint.md", change: "modified" as const, unifiedDiff: editDiff() }], omissions: [] } }, "checkpoint.md"],
    ["global memory", { ...memoryEntry(), id: "global-memory", mutation: { version: 1 as const, files: [{ path: "USER.md", change: "modified" as const, unifiedDiff: editDiff() }], omissions: [] } }, "USER.md"],
    ["global skill", { ...memoryEntry(), id: "global-skill", name: "skill_manage", presentation: resolveToolPresentation("skill_manage", { action: "save", name: "global-notes" }, CWD), resultAction: "created" as const, mutation: { version: 1 as const, files: [{ path: "global-notes/SKILL.md", change: "added" as const, unifiedDiff: editDiff() }], omissions: [] } }, "global-notes/SKILL.md"],
    ["legacy memory", { ...memoryEntry(), id: "legacy-memory", mutation: undefined, diff: editDiff() }, "const filler22 = 22"],
    ["legacy skill", { ...memoryEntry(), id: "legacy-skill", name: "skill_manage", presentation: resolveToolPresentation("skill_manage", { action: "save", name: "global-notes" }, CWD), mutation: undefined, diff: editDiff() }, "const filler22 = 22"],
  ])("keeps a successful %s mutation at zero lines until expansion", async (_label, block, hiddenContent) => {
    const { mutation, ...row } = block
    const fixture = mutation === undefined ? undefined : await mutationEvidenceFixture(mutation)
    const result = await renderToolEntry({ ...row, ...(fixture ? { mutationEvidence: fixture.evidence } : {}) }, { height: 64, evidenceReader: fixture?.reader })
    try {
      await result.renderOnce()
      const collapsed = await restingFrameLines(result)
      expect(collapsed).toHaveLength(1)
      expect(collapsed[0]).toEndWith("▸")

      await result.mockMouse.click(4, 0)
      if (fixture) for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
      const expanded = await restingFrameLines(result)
      expect(expanded.join("\n")).toContain(hiddenContent)
      expect(expanded).toContain("     32  const filler22 = 22")
    } finally {
      result.renderer.destroy(); fixture?.reader.dispose()
    }
  })

  it("states a source-level mutation omission and never requests hydration for it", async () => {
    const hydrate = mock((_blockId: string) => {})
    const fixture = await mutationEvidenceFixture({ version: 1, files: [], omissions: [{ path: ".flywheel/memory/global.md", reason: "sensitive" }] })
    const result = await renderToolEntry({
      ...memoryEntry(),
      mutationEvidence: fixture.evidence,
    }, { height: 64, onHydrateBody: hydrate, evidenceReader: fixture.reader })
    try {
      await result.renderOnce()
      await result.mockMouse.click(4, 0)
      for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
      const expanded = await restingFrameLines(result)

      expect(expanded).toContain("      .flywheel/memory/global.md  (diff omitted: sensitive)")
      expect(expanded).not.toContain("      (click to collapse)")
      expect(hydrate).not.toHaveBeenCalled()
    } finally {
      result.renderer.destroy(); fixture.reader.dispose()
    }
  })
})

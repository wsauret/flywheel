import { describe, expect, it, mock } from "bun:test"
import { TOOL_PREVIEW_LINE_LIMIT, type SystemBlock as SystemBlockType } from "../../../../src/infra/output-blocks.js"
import { mutationEvidenceFixture } from "./_mutation-evidence-fixture.js"
import type { MutationEvidenceReader } from "../../../../src/protocol/client/mutation-evidence.js"
import flywheelThemeJson from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"

const theme = resolveTheme(flywheelThemeJson, "dark")

interface RenderSystemBlockOptions {
  height?: number
  onHydrateBody?: (blockId: string) => void
  evidenceReader?: MutationEvidenceReader
}

async function renderSystemBlock(block: SystemBlockType, opts?: RenderSystemBlockOptions) {
  const [{ testRender }, { createComponent }, { SystemBlock }, { ThemeProvider }, { MutationEvidenceProvider }, { BlockDisclosureProvider, createBlockDisclosureChannel }] = await Promise.all([
    import("@opentui/solid"),
    import("solid-js/web"),
    import("../../../../src/tui/output-blocks/system-block.js"),
    import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/context/mutation-evidence.js"),
    import("../../../../src/tui/context/block-disclosure.js"),
  ])

  return testRender(
    () => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(MutationEvidenceProvider, {
          reader: () => opts?.evidenceReader,
          get children() {
            return createComponent(BlockDisclosureProvider, {
              value: createBlockDisclosureChannel(),
              get children() {
                return createComponent(SystemBlock, { block, onHydrateBody: opts?.onHydrateBody })
              },
            })
          },
        })
      },
    }),
    { width: 80, height: opts?.height ?? 4 },
  )
}

/** Resting frame as its non-blank lines: the mouse parks below the block so the
 *  hover rail in the body gutter never enters the captured frame. */
async function restingFrameLines(result: Awaited<ReturnType<typeof renderSystemBlock>>, height: number): Promise<string[]> {
  await result.mockMouse.moveTo(79, height - 1)
  await result.renderOnce()
  return result.captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
}

function skillPatch(hunkLines: number): string {
  const lines = [
    "--- a/.flywheel/skills/provider-quirks/SKILL.md",
    "+++ b/.flywheel/skills/provider-quirks/SKILL.md",
    `@@ -1,${hunkLines} +1,${hunkLines} @@`,
  ]
  for (let index = 0; index < hunkLines; index += 1) lines.push(`+quirk ${index}`)
  return lines.join("\n")
}

function reviewNotice(over: Partial<SystemBlockType> = {}): SystemBlockType {
  return {
    kind: "system",
    id: "notice-1",
    message: "Updated skill: provider-quirks.",
    timestamp: Date.now(),
    ...over,
  }
}
async function retainedNotice(hunkLines: number) {
  const fixture = await mutationEvidenceFixture({ version: 1, files: [
    { path: ".flywheel/skills/provider-quirks/SKILL.md", change: "modified", unifiedDiff: skillPatch(hunkLines) },
  ], omissions: [] })
  return { block: reviewNotice({ mutationEvidence: fixture.evidence }), fixture }
}

describe("system block", () => {
  it("discloses reference-backed review paths in their original flat order", async () => {
    const fixture = await mutationEvidenceFixture([
      { path: "first/SKILL.md", patch: skillPatch(2), lines: 2 },
      { path: "second/SKILL.md", patch: skillPatch(2), lines: 2 },
    ])
    const result = await renderSystemBlock(reviewNotice({ mutationEvidence: fixture.evidence }), {
      height: 32, evidenceReader: fixture.reader,
    })
    try {
      await result.renderOnce()
      expect(fixture.calls).toHaveLength(0)
      expect(result.captureCharFrame()).not.toContain("first/SKILL.md")
      await result.mockMouse.click(2, 0)
      for (let frame = 0; frame < 4; frame++) { await result.renderOnce(); await fixture.settle() }
      const lines = await restingFrameLines(result, 32)
      expect(lines.filter(line => line.includes("SKILL.md"))).toEqual([
        "      first/SKILL.md",
        "      second/SKILL.md",
      ])
      expect(lines.filter(line => line.includes("quirk 0"))).toHaveLength(2)
      expect(lines.some(line => line.includes("reach") || line.includes("action:"))).toBe(false)
    } finally { result.renderer.destroy(); fixture.reader.dispose() }
  })

  it("starts selection on the blank row before an implicit divider", async () => {
    const [{ testRender }, { createComponent }, { Divider }, { ThemeProvider }] = await Promise.all([
      import("@opentui/solid"),
      import("solid-js/web"),
      import("../../../../src/tui/output-blocks/system-block.js"),
      import("../../../../src/tui/context/theme.js"),
    ])
    const result = await testRender(
      () => createComponent(ThemeProvider, {
        mode: "dark",
        get children() { return createComponent(Divider, {}) },
      }),
      { width: 40, height: 4 },
    )
    try {
      await result.renderOnce()
      expect(result.captureCharFrame().split("\n")[0]!.trim()).toBe("")
      await result.mockMouse.drag(0, 0, 10, 1)
      expect(result.renderer.getSelection()?.getSelectedText()).toContain("─")
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders a notice without mutations exactly as before, with no affordance", async () => {
    const result = await renderSystemBlock({ kind: "system", id: "sys-2", message: "Updated skill: `provider-quirks`.", timestamp: Date.now() })
    try {
      expect(await restingFrameLines(result, 4)).toEqual(["• Updated skill: provider-quirks."])
      const span = result.captureSpans().lines.flatMap(line => line.spans).find(candidate => candidate.text.includes("Updated skill:"))
      expect(span?.fg.equals(theme.secondary)).toBe(true)
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders returned input verbatim with a muted header and readable words", async () => {
    const header = "Explorer finished before reading your message:"
    const words = "rename `foo` to `bar`"
    const message = `${header}\n\n${words}\n  keep  spacing`
    const result = await renderSystemBlock({ kind: "system", id: "returned-input:child:person:send", message, timestamp: 0 }, { height: 6 })
    try {
      await result.renderOnce()
      expect(result.captureCharFrame().split("\n").slice(0, 4).map(line => line.slice(2).trimEnd()).join("\n")).toBe(message)
      const spans = result.captureSpans().lines.flatMap(line => line.spans)
      expect(spans.find(span => span.text.includes(header))?.fg.equals(theme.textMuted)).toBe(true)
      expect(spans.find(span => span.text.includes(words))?.fg.equals(theme.text)).toBe(true)
    } finally {
      result.renderer.destroy()
    }
  })

  it("hides a reloaded review notice's diff until disclosure", async () => {
    const { block, fixture } = await retainedNotice(4)
    const result = await renderSystemBlock(block, { height: 32, evidenceReader: fixture.reader })
    try {
      expect(await restingFrameLines(result, 32)).toEqual([
        "• Updated skill: provider-quirks. ▸",
      ])

      await result.mockMouse.moveTo(2, 0)
      await result.renderOnce()
      await result.mockMouse.click(2, 0)
      for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
      expect(await restingFrameLines(result, 32)).toEqual([
        "• Updated skill: provider-quirks. ▾",
        "      .flywheel/skills/provider-quirks/SKILL.md",
        "     1 +quirk 0",
        "     2 +quirk 1",
        "     3 +quirk 2",
        "     4 +quirk 3",
      ])

      // The header takes only its text; the shown diff takes every cell,
      // including the space after its short last line.
      await result.mockMouse.click(60, 0)
      await result.renderOnce()
      const lastLine = result.captureCharFrame().split("\n").findIndex(line => line.includes("+quirk 3"))
      expect(await restingFrameLines(result, 32)).toHaveLength(6)
      await result.mockMouse.click(60, lastLine)
      expect(await restingFrameLines(result, 32)).toEqual([
        "• Updated skill: provider-quirks. ▸",
      ])
    } finally {
      result.renderer.destroy(); fixture.reader.dispose()
    }
  })

  it("reveals the complete retained review mutation after disclosure", async () => {
    const { block, fixture } = await retainedNotice(TOOL_PREVIEW_LINE_LIMIT + 3)
    const result = await renderSystemBlock(block, { height: 64, evidenceReader: fixture.reader })
    try {
      expect(await restingFrameLines(result, 64)).toEqual([
        "• Updated skill: provider-quirks. ▸",
      ])

      await result.mockMouse.moveTo(2, 0)
      await result.renderOnce()
      await result.mockMouse.click(2, 0)
      for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
      const expanded = await restingFrameLines(result, 64)
      expect(expanded).toContain("     23 +quirk 22")
      expect(expanded.at(-1)).toBe("      (click to collapse)")
    } finally {
      result.renderer.destroy(); fixture.reader.dispose()
    }
  })

  it("reads notice byte windows only after disclosure without whole-body hydration", async () => {
    const hydrate = mock((_blockId: string) => {})
    const { block, fixture } = await retainedNotice(4)
    const result = await renderSystemBlock(block, {
      height: 32,
      onHydrateBody: hydrate,
      evidenceReader: fixture.reader,
    })
    try {
      await result.renderOnce()
      expect(hydrate).not.toHaveBeenCalled()
      expect(fixture.calls).toHaveLength(0)

      await result.mockMouse.moveTo(2, 0)
      await result.renderOnce()
      await result.mockMouse.click(2, 0)
      for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
      expect(hydrate).not.toHaveBeenCalled()
      expect(fixture.calls.map(call => call.type)).toEqual(["mutationFiles", "mutationPatchWindow"])
    } finally {
      result.renderer.destroy(); fixture.reader.dispose()
    }
  })
})

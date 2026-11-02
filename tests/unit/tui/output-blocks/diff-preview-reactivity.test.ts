import { expect, it } from "bun:test"
import { BoxRenderable, StyledText, TextRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createComponent, createSignal } from "solid-js"
import { createStore, reconcile, type DeepMutable } from "solid-js/store"
import { isServer } from "solid-js/web"
import type { ProvisionalDiff } from "../../../../src/infra/output-blocks.js"
import { ThemeProvider } from "../../../../src/tui/context/theme.js"
import { DiffPreview, parseDiffs } from "../../../../src/tui/output-blocks/diff-preview.js"

function proposal(hiddenTail: string): DeepMutable<ProvisionalDiff> {
  return {
    files: [{
      id: "file-0",
      path: "src/preview.ts",
      action: "update",
      hunks: [{
        id: "hunk-0",
        oldStart: 1,
        newStart: 1,
        omittedBefore: 0,
        omittedAfter: 0,
        lines: Array.from({ length: 22 }, (_, index) => ({
          id: `line-${index}`,
          kind: "add" as const,
          text: index === 21 ? hiddenTail : `const preview_visible_${index} = ${index}`,
          partial: index === 21,
        })),
      }],
    }],
  }
}

it("keeps visible diff buffers untouched when only a hidden streaming line changes", async () => {
  expect(isServer).toBe(false)
  const [streaming, setStreaming] = createStore(proposal("const hidden_tail = 1"))
  const [expanded, setExpanded] = createSignal(false)
  const descriptor = Object.getOwnPropertyDescriptor(TextRenderable.prototype, "content")
  if (!descriptor?.get || !descriptor.set) throw new Error("TextRenderable content accessors missing")
  const originalGet = descriptor.get
  const originalSet = descriptor.set
  const rows = new Set<TextRenderable>()
  let writes = 0
  Object.defineProperty(TextRenderable.prototype, "content", {
    ...descriptor,
    get() { return originalGet.call(this) },
    set(this: TextRenderable, value: unknown) {
      if (value instanceof StyledText && value.chunks.some((chunk) => chunk.text.includes("preview_visible_"))) {
        rows.add(this)
        writes += 1
      }
      originalSet.call(this, value)
    },
  })
  let result: Awaited<ReturnType<typeof testRender>> | undefined
  try {
    result = await testRender(
      () => createComponent(ThemeProvider, {
        mode: "dark",
        get children() {
          return createComponent(DiffPreview, {
            get parsed() { return parseDiffs(streaming.files, expanded()) },
          })
        },
      }),
      { width: 80, height: 32 },
    )
    await result.renderOnce()
    const before = result.captureCharFrame()
    const beforeSpans = result.captureSpans()
    const visibleRows = [...rows]
    const contents = visibleRows.map((row) => row.content)
    expect(visibleRows).toHaveLength(20)
    expect(before).toContain("const preview_visible_19 = 19")
    expect(before).not.toContain("hidden_tail")
    expect(before).toContain("... +2 lines (click to expand)")
    writes = 0

    setStreaming(reconcile(proposal("const hidden_tail = 12")))
    await result.renderOnce()

    expect(result.captureCharFrame()).toBe(before)
    expect(result.captureSpans()).toEqual(beforeSpans)
    expect(writes).toBe(0)
    for (const [index, row] of visibleRows.entries()) {
      expect(contents[index]).toBe(row.content)
      expect(row.selectable).toBe(true)
    }

    const lastRow = visibleRows.at(-1)
    if (!(lastRow?.parent instanceof BoxRenderable)) throw new Error("Visible diff row box missing")
    const rowBox = lastRow.parent
    const previousBackground = rowBox.backgroundColor
    setStreaming("files", 0, "hunks", 0, "lines", 19, {
      text: "const preview_visible_19 = 99",
      kind: "remove",
    })
    await result.renderOnce()

    expect(writes).toBe(1)
    expect(lastRow.content).not.toBe(contents.at(-1))
    expect(result.captureCharFrame()).toContain("-const preview_visible_19 = 99")
    expect(result.captureCharFrame()).not.toContain("const preview_visible_19 = 19")
    expect(rowBox.backgroundColor.equals(previousBackground)).toBe(false)

    await result.mockMouse.drag(lastRow.x, lastRow.y, 60, lastRow.y)
    expect(result.renderer.getSelection()?.getSelectedText()).toContain("const preview_visible_19 = 99")
    result.renderer.clearSelection()
    setExpanded(true)
    await result.renderOnce()
    expect(result.captureCharFrame()).toContain("const hidden_tail = 12")
    expect(result.captureCharFrame()).toContain("(click to collapse)")
  } finally {
    result?.renderer.destroy()
    Object.defineProperty(TextRenderable.prototype, "content", descriptor)
  }
})

// Solid answers a read of a pending memo by first running the memo's stale
// owners. A file view's cleanup that called back into the report path read the
// parent's reactive state, so a tab switch re-ran the branch that was disposing
// the view and corrupted the reactive graph. Unmount runs only the retraction
// that the last report returned.
it("retracts a file's truncation at unmount through the retraction its report returned", async () => {
  const [files, setFiles] = createSignal(proposal("const hidden_tail = 1").files)
  const reports: boolean[] = []
  const retracted: number[] = []
  let result: Awaited<ReturnType<typeof testRender>> | undefined
  try {
    result = await testRender(
      () => createComponent(ThemeProvider, {
        mode: "dark",
        get children() {
          return createComponent(DiffPreview, {
            get parsed() { return parseDiffs(files(), false) },
            onTruncated: (index: number, truncated: boolean) => {
              reports.push(truncated)
              return () => { retracted.push(index) }
            },
          })
        },
      }),
      { width: 80, height: 32 },
    )
    await result.renderOnce()
    await result.renderOnce()
    expect(reports).toEqual([true])

    setFiles([])
    await result.renderOnce()

    expect(reports).toEqual([true])
    expect(retracted).toEqual([0])
  } finally {
    result?.renderer.destroy()
  }
})

import { describe, expect, it } from "bun:test"
import { SyntaxStyle, TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"

import { createPasteCollapse } from "../../../../src/tui/hooks/paste-collapse.js"

type TestRender = Awaited<ReturnType<typeof createTestRenderer>>

/** Runs `run` against a mounted textarea whose cursor sits at the end of `initialText`,
 *  and a syntax style that registers no paste style. */
async function withTextarea(initialText: string, run: (textarea: TextareaRenderable, style: SyntaxStyle, render: TestRender) => void): Promise<void> {
  const render = await createTestRenderer({ width: 80, height: 5 })
  const style = SyntaxStyle.fromStyles({}, render.renderer.nativeScene)
  try {
    const textarea = new TextareaRenderable(render.renderer, { width: 80, height: 5, initialValue: initialText })
    render.renderer.root.add(textarea)
    textarea.cursorOffset = initialText.length
    run(textarea, style, render)
  } finally { style.destroy(); await render.dispose() }
}

describe("createPasteCollapse", () => {
  it("collapses one large paste and expands it on submit", async () => {
    const pasted = [
      "Reply with exactly: bracket paste ok",
      "context line 1",
      "context line 2",
      "context line 3",
      "context line 4",
      "context line 5",
    ].join("\n")
    await withTextarea("", (textarea, style) => {
      const collapse = createPasteCollapse(textarea, () => style)

      expect(collapse.applyPaste(pasted)).toBe(true)
      expect(textarea.plainText).toBe("[Pasted ~6 lines]")
      expect(collapse.expandForSubmit()).toBe(pasted)
    })
  })

  it("inserts an ordinary paste once", async () => {
    await withTextarea("hell", (textarea, style) => {
      const collapse = createPasteCollapse(textarea, () => style)

      expect(collapse.applyPaste("o")).toBe(false)
      expect(textarea.plainText).toBe("hello")
    })
  })

  it("collapses only the pasted span and preserves the surrounding draft", async () => {
    const message = "my draft line\n"
    await withTextarea(message, (textarea, style) => {
      const collapse = createPasteCollapse(textarea, () => style)

      const pasted = ["p1", "p2", "p3", "p4", "p5"].join("\n")
      expect(collapse.applyPaste(pasted)).toBe(true)
      expect(textarea.plainText).toBe(`${message}[Pasted ~5 lines]`)
      expect(collapse.expandForSubmit()).toBe(message + pasted)
    })
  })

  it("restores collapsed paste placeholders after the original editor is destroyed", async () => {
    const pasted = ["p1", "p2", "p3", "p4", "p5"].join("\n")
    await withTextarea("", (textarea, style, render) => {
      const collapse = createPasteCollapse(textarea, () => style)
      expect(collapse.applyPaste(pasted)).toBe(true)

      const savedText = textarea.plainText
      textarea.destroy()
      const savedPastes = collapse.serialize()
      const next = new TextareaRenderable(render.renderer, { width: 80, height: 5, initialValue: savedText })
      render.renderer.root.add(next)
      const restored = createPasteCollapse(next, () => style)
      restored.restore(savedPastes)

      expect(next.plainText).toBe("[Pasted ~5 lines]")
      expect(restored.expandForSubmit()).toBe(pasted)
    })
  })

  it("does not infer paste metadata from restored typed multiline drafts", async () => {
    const message = ["line one", "line two", "line three", "line four", "line five"].join("\n")
    await withTextarea("", (textarea, style) => {
      const collapse = createPasteCollapse(textarea, () => style)

      textarea.insertText(message)
      collapse.restore([])
      textarea.insertText("!")

      expect(textarea.plainText).toBe(`${message}!`)
      expect(collapse.serialize()).toEqual([])
    })
  })

  it("uses the current syntax style when creating paste extmarks", async () => {
    await withTextarea("", (textarea, initial, render) => {
      const current = SyntaxStyle.fromStyles({ "extmark.paste": { bold: true } }, render.renderer.nativeScene)
      try {
        let style = initial
        const collapse = createPasteCollapse(textarea, () => style)

        style = current

        expect(collapse.applyPaste("line 1\nline 2\nline 3\nline 4\nline 5")).toBe(true)
        const styleId = current.resolveStyleId("extmark.paste")
        expect(styleId).not.toBeNull()
        expect(textarea.extmarks.getAll()[0]?.styleId).toBe(styleId ?? undefined)
      } finally { current.destroy() }
    })
  })
})

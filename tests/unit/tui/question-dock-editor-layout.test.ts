import { describe, expect, it } from "bun:test"
import { layoutQuestionDockEditor } from "../../../src/tui/question-dock-editor-layout.js"

describe("layoutQuestionDockEditor", () => {
  it("keeps a cursor-bearing word intact when it fits on the continuation row", () => {
    const layout = layoutQuestionDockEditor({
      prefix: "Other - ",
      value: "a bbb",
      cursor: 2,
      selection: null,
      width: 12,
      showCaret: true,
    })

    expect(layout.text).toBe("Other - a \n  bbb")
    expect(layout.caret).toEqual({ row: 1, column: 2 })
  })

  it("lays out a caret on a wrapped space without reflowing the text", () => {
    const options = { prefix: "Other - ", value: "abcde 12345678901", selection: null, width: 13 }
    const withoutCaret = layoutQuestionDockEditor({ ...options, cursor: 5, showCaret: false })
    const layout = layoutQuestionDockEditor({ ...options, cursor: 5, showCaret: true })

    expect(layout.text).toBe(withoutCaret.text)
    expect(layout.visualLines).toEqual(withoutCaret.visualLines)
    expect(layout.caret).toEqual({ row: 1, column: 1 })
  })
})

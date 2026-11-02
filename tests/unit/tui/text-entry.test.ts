import { describe, expect, it } from "bun:test"
import {
  createControlledTextEditor,
  MULTILINE_TEXT_ENTRY_POLICY,
  normalizedPrintableText,
  resolveTextEntryAction,
  SINGLE_LINE_TEXT_ENTRY_POLICY,
  type TextEntryVisualLine,
} from "../../../src/tui/keymap/text-entry.js"

function createEditor(initial: string, multiline = false, visualLines?: () => readonly TextEntryVisualLine[]) {
  let value = initial
  const editor = createControlledTextEditor({
    value: () => value,
    setValue: (next) => { value = next },
    policy: multiline ? MULTILINE_TEXT_ENTRY_POLICY : SINGLE_LINE_TEXT_ENTRY_POLICY,
    visualLines,
  })
  return { editor, value: () => value }
}

describe("normalized printable text", () => {
  it("prefers terminal text and rejects modified or non-printing keys", () => {
    expect(normalizedPrintableText({ name: "a", sequence: "A", raw: "a" })).toBe("A")
    expect(normalizedPrintableText({ name: "x", shift: true })).toBe("X")
    expect(normalizedPrintableText({ name: "space" })).toBe(" ")
    expect(normalizedPrintableText({ name: "a", meta: true, raw: "a" })).toBeNull()
    expect(normalizedPrintableText({ name: "return", sequence: "\r" })).toBeNull()
  })
})

describe("controlled text editor", () => {
  it("replaces directional selections and keeps cursor offsets grapheme-safe", () => {
    const { editor, value } = createEditor("a👩‍💻b")
    editor.setCursor("a👩‍💻b".length)

    expect(editor.handleKey({ name: "left", shift: true })).toBe("handled")
    expect(editor.presentation().selection).toEqual({ start: 6, end: 7 })
    expect(editor.handleKey({ name: "left", shift: true })).toBe("handled")
    expect(editor.presentation().selection).toEqual({ start: 1, end: 7 })
    expect(editor.handleKey({ name: "x", raw: "x" })).toBe("handled")
    expect(value()).toBe("ax")
    expect(editor.presentation().cursor).toBe(2)
  })

  it("resolves shared Ctrl history bindings and restores selection", () => {
    const single = createEditor("abc")
    single.editor.setSelection(1, 3)
    single.editor.handlePaste("X\r\nY")
    expect(single.value()).toBe("aXY")
    expect(single.editor.handleKey({ name: "z", ctrl: true })).toBe("handled")
    expect(single.value()).toBe("abc")
    expect(single.editor.presentation().selection).toEqual({ start: 1, end: 3 })
    expect(single.editor.handleKey({ name: "y", ctrl: true })).toBe("handled")
    expect(single.value()).toBe("aXY")
    expect(single.editor.handleKey({ name: "z", ctrl: true })).toBe("handled")
    expect(single.editor.handleKey({ name: "z", ctrl: true, shift: true })).toBe("handled")
    expect(single.value()).toBe("aXY")

    const multiline = createEditor("", true)
    multiline.editor.handlePaste("a\r\nb\rc")
    expect(multiline.value()).toBe("a\nb\nc")
  })

  it("supports word, line, buffer, and selection-aware deletion operations", () => {
    const { editor, value } = createEditor("one two\nthree", true)
    editor.setCursor(7)
    editor.handleKey({ name: "left", ctrl: true })
    expect(editor.presentation().cursor).toBe(4)
    editor.handleKey({ name: "k", ctrl: true })
    expect(value()).toBe("one \nthree")
    editor.handleKey({ name: "home" })
    expect(editor.presentation().cursor).toBe(0)
    editor.handleKey({ name: "end", shift: true })
    expect(editor.presentation().selection).toEqual({ start: 0, end: 10 })
    editor.handleKey({ name: "backspace" })
    expect(value()).toBe("")
  })

  it("uses rendered lines and a preferred visual column for vertical movement", () => {
    let lines: readonly TextEntryVisualLine[] = [
      { start: 0, end: 3 },
      { start: 3, end: 5 },
      { start: 6, end: 10 },
    ]
    const { editor } = createEditor("abcde\nwxyz", true, () => lines)
    editor.setCursor(3)
    editor.handleKey({ name: "down" })
    expect(editor.presentation().cursor).toBe(5)
    expect(editor.presentation().preferredVisualColumn).toBe(3)
    editor.handleKey({ name: "down" })
    expect(editor.presentation().cursor).toBe(9)
    editor.handleKey({ name: "up", shift: true })
    expect(editor.presentation().selection).toEqual({ start: 5, end: 9 })
    lines = [{ start: 0, end: 10 }]
  })

  it("returns submit, cancel, and unhandled outcomes without consuming Ctrl+W or Ctrl+C", () => {
    const single = createEditor("send")
    expect(single.editor.handleKey({ name: "return" })).toBe("submit")
    expect(single.editor.handleKey({ name: "enter" })).toBe("submit")
    expect(single.editor.handleKey({ name: "escape" })).toBe("cancel")
    expect(single.editor.handleKey({ name: "w", ctrl: true })).toBe("unhandled")
    expect(single.editor.handleKey({ name: "c", ctrl: true })).toBe("unhandled")

    const multiline = createEditor("")
    expect(multiline.editor.handleKey({ name: "up" })).toBe("unhandled")
  })

  it("resets only editor-owned ephemeral state", () => {
    const { editor, value } = createEditor("abc")
    editor.setSelection(0, 2)
    editor.handleKey({ name: "x", raw: "x" })
    editor.resetEphemeralState({ cursor: 1 })
    expect(value()).toBe("xc")
    expect(editor.presentation()).toEqual({
      value: "xc",
      cursor: 1,
      selection: null,
      preferredVisualColumn: null,
    })
    editor.handleKey({ name: "-", ctrl: true })
    expect(value()).toBe("xc")
  })

  it("sanitizes pasted terminal controls while preserving multiline LF", () => {
    const single = createEditor("")
    single.editor.handlePaste("a\u001bb\u0007c\u007fd\n")
    expect(single.value()).toBe("abcd")
    const multi = createEditor("", true)
    multi.editor.handlePaste("a\r\nb\u001bc\n")
    expect(multi.value()).toBe("a\nbc\n")
  })

  it("can disable history so undo cannot restore replaced credentials", () => {
    let value = "old-secret"
    const editor = createControlledTextEditor({ value: () => value, setValue: (next) => { value = next }, policy: SINGLE_LINE_TEXT_ENTRY_POLICY, history: "disabled" })
    editor.setSelection(0, value.length)
    editor.handlePaste("new-secret")
    expect(resolveTextEntryAction({ name: "z", ctrl: true })).toBe("undo")
    editor.handleKey({ name: "z", ctrl: true })
    expect(value).toBe("new-secret")
  })

  it("bounds full-buffer undo snapshots by count", () => {
    let value = "0"
    const editor = createControlledTextEditor({ value: () => value, setValue: (next) => { value = next }, policy: SINGLE_LINE_TEXT_ENTRY_POLICY })
    for (let index = 1; index <= 110; index++) {
      editor.setSelection(0, value.length)
      editor.handlePaste(String(index))
    }
    for (let index = 0; index < 100; index++) editor.handleKey({ name: "z", ctrl: true })
    expect(value).not.toBe("0")
  })
})
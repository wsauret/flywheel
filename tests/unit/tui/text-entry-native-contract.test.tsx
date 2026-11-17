/** @jsxImportSource @opentui/solid */

import { describe, expect, it } from "bun:test"
import { defaultTextareaKeyBindings } from "@opentui/core"
import {
  createControlledTextEditor,
  MULTILINE_TEXT_ENTRY_POLICY,
  NATIVE_TEXT_ENTRY_KEY_BINDINGS,
  TEXT_ENTRY_KEY_BINDINGS,
  type TextEntryKeyEvent,
} from "../../../src/tui/keymap/text-entry.js"

/** Applies keys to a multiline editor that holds "ab" with the cursor between the letters. */
function edit(...events: TextEntryKeyEvent[]) {
  let value = "ab"
  const editor = createControlledTextEditor({ value: () => value, setValue: (next) => { value = next }, policy: MULTILINE_TEXT_ENTRY_POLICY, initialCursor: 1 })
  const results = events.map((event) => editor.handleKey(event))
  return { results, value, selection: editor.presentation().selection }
}

describe("native text-entry contract", () => {
  it("adapts the semantic table to a mutable native-safe array", () => {
    expect(edit({ name: "a", ctrl: true, shift: true }).selection).toEqual({ start: 0, end: 2 })
    expect(edit({ name: "a", super: true }).selection).toEqual({ start: 0, end: 2 })
    expect(edit({ name: "kpenter" }).results).toEqual(["submit"])
    expect(edit({ name: "kpenter", shift: true }).value).toBe("a\nb")
    expect(edit({ name: "linefeed", ctrl: true }).value).toBe("a\nb")
    expect(edit({ name: "linefeed" }).results).toEqual(["submit"])
    expect(edit({ name: "x", raw: "x" }, { name: "z", ctrl: true }).value).toBe("ab")
    expect(edit({ name: "x", raw: "x" }, { name: "z", ctrl: true }, { name: "y", ctrl: true }).value).toBe("axb")
    expect(edit({ name: "x", raw: "x" }, { name: "z", ctrl: true }, { name: "z", ctrl: true, shift: true }).value).toBe("axb")
    expect(TEXT_ENTRY_KEY_BINDINGS.filter((binding) => binding.name === "linefeed" && !binding.ctrl && !binding.shift)).toEqual([{ name: "linefeed", action: "submit" }])
    expect(edit({ name: "enter" }).results).toEqual(["submit"])
    expect(edit({ name: "enter", shift: true }).value).toBe("a\nb")
    expect(NATIVE_TEXT_ENTRY_KEY_BINDINGS).toContainEqual({ name: "return", meta: true, action: "submit" })
    expect(NATIVE_TEXT_ENTRY_KEY_BINDINGS).toContainEqual({ name: "kpenter", meta: true, action: "submit" })
    expect(TEXT_ENTRY_KEY_BINDINGS.filter((binding) => binding.name === "a" && binding.super && !binding.shift)).toEqual([{ name: "a", super: true, action: "select-all" }])
    expect(NATIVE_TEXT_ENTRY_KEY_BINDINGS.some((binding) => String(binding.action) === "cancel")).toBe(false)
    expect(Array.isArray(NATIVE_TEXT_ENTRY_KEY_BINDINGS)).toBe(true)
    expect(TEXT_ENTRY_KEY_BINDINGS).toContainEqual({ name: "escape", action: "cancel" })
    expect(defaultTextareaKeyBindings).toContainEqual({ name: "a", ctrl: true, shift: true, action: "select-line-home" })
  })
})

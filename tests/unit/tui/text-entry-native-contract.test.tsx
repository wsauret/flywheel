/** @jsxImportSource @opentui/solid */

import { describe, expect, it } from "bun:test"
import { defaultTextareaKeyBindings } from "@opentui/core"
import {
  NATIVE_TEXT_ENTRY_KEY_BINDINGS,
  TEXT_ENTRY_KEY_BINDINGS,
  resolveTextEntryAction,
} from "../../../src/tui/keymap/text-entry.js"

describe("native text-entry contract", () => {
  it("adapts the semantic table to a mutable native-safe array", () => {
    expect(resolveTextEntryAction({ name: "a", ctrl: true, shift: true })).toBe("select-all")
    expect(resolveTextEntryAction({ name: "a", super: true })).toBe("select-all")
    expect(resolveTextEntryAction({ name: "kpenter" })).toBe("submit")
    expect(resolveTextEntryAction({ name: "kpenter", shift: true })).toBe("newline")
    expect(resolveTextEntryAction({ name: "linefeed", ctrl: true })).toBe("newline")
    expect(resolveTextEntryAction({ name: "linefeed" })).toBe("submit")
    expect(resolveTextEntryAction({ name: "z", ctrl: true })).toBe("undo")
    expect(resolveTextEntryAction({ name: "y", ctrl: true })).toBe("redo")
    expect(resolveTextEntryAction({ name: "z", ctrl: true, shift: true })).toBe("redo")
    expect(TEXT_ENTRY_KEY_BINDINGS.filter((binding) => binding.name === "linefeed" && !binding.ctrl && !binding.shift)).toEqual([{ name: "linefeed", action: "submit" }])
    expect(resolveTextEntryAction({ name: "enter" })).toBe("submit")
    expect(resolveTextEntryAction({ name: "enter", shift: true })).toBe("newline")
    expect(NATIVE_TEXT_ENTRY_KEY_BINDINGS).toContainEqual({ name: "return", meta: true, action: "submit" })
    expect(NATIVE_TEXT_ENTRY_KEY_BINDINGS).toContainEqual({ name: "kpenter", meta: true, action: "submit" })
    expect(TEXT_ENTRY_KEY_BINDINGS.filter((binding) => binding.name === "a" && binding.super && !binding.shift)).toEqual([{ name: "a", super: true, action: "select-all" }])
    expect(NATIVE_TEXT_ENTRY_KEY_BINDINGS.some((binding) => String(binding.action) === "cancel")).toBe(false)
    expect(Array.isArray(NATIVE_TEXT_ENTRY_KEY_BINDINGS)).toBe(true)
    expect(TEXT_ENTRY_KEY_BINDINGS).toContainEqual({ name: "escape", action: "cancel" })
    expect(defaultTextareaKeyBindings).toContainEqual({ name: "a", ctrl: true, shift: true, action: "select-line-home" })
  })

})
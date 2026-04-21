import { describe, it, expect } from "bun:test"
import { consumeSelectedText } from "../../src/tui/utils/selection.js"

describe("consumeSelectedText", () => {
  it("returns selected text and clears the selection", () => {
    let cleared = false
    const text = consumeSelectedText({
      getSelection: () => ({ getSelectedText: () => "copied text" }),
      clearSelection: () => { cleared = true },
    })

    expect(text).toBe("copied text")
    expect(cleared).toBe(true)
  })

  it("clears empty selections without attempting to copy", () => {
    let cleared = false
    const text = consumeSelectedText({
      getSelection: () => ({ getSelectedText: () => "" }),
      clearSelection: () => { cleared = true },
    })

    expect(text).toBeNull()
    expect(cleared).toBe(true)
  })

  it("clears even when there is no active selection", () => {
    let cleared = false
    const text = consumeSelectedText({
      getSelection: () => null,
      clearSelection: () => { cleared = true },
    })

    expect(text).toBeNull()
    expect(cleared).toBe(true)
  })
})

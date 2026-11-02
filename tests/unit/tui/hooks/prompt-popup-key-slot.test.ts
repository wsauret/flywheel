import { describe, expect, it } from "bun:test"
import { createComposerPopupKeySlot } from "../../../../src/tui/hooks/create-composer-popup-key-slot.js"

describe("createComposerPopupKeySlot", () => {
  it("reports unhandled without a registration and delegates after one", () => {
    const slot = createComposerPopupKeySlot()
    expect(slot.input({ name: "escape" })).toBe(false)
    slot.register((evt) => evt.name === "escape")
    expect(slot.input({ name: "escape" })).toBe(true)
    expect(slot.input({ name: "tab" })).toBe(false)
  })

  it("a later registration replaces the earlier one", () => {
    const slot = createComposerPopupKeySlot()
    slot.register(() => true)
    slot.register((evt) => evt.name === "up")
    expect(slot.input({ name: "escape" })).toBe(false)
    expect(slot.input({ name: "up" })).toBe(true)
  })
})

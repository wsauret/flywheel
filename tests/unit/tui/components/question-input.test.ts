import { describe, expect, mock, test } from "bun:test"
import { createQuestionInputRegistry } from "../../../../src/tui/components/question-input.js"

describe("question input registry", () => {
  test("input returns the registered key handler's handled verdict", () => {
    const registry = createQuestionInputRegistry()
    const onKey = mock((_evt: { name: string }) => true)
    registry.register({ onKey, onPaste: () => {} })

    expect(registry.input({ name: "escape" })).toBe(true)
    expect(onKey).toHaveBeenCalledTimes(1)

    onKey.mockReturnValue(false)
    expect(registry.input({ name: "tab" })).toBe(false)
  })

  test("paste routes to the registered paste handler", () => {
    const registry = createQuestionInputRegistry()
    const onPaste = mock(() => {})
    registry.register({ onKey: () => true, onPaste })

    expect(registry.paste("pasted text")).toBe(true)
    expect(onPaste).toHaveBeenCalledWith("pasted text")
  })

  test("clear stops routing to the previously registered handlers", () => {
    const registry = createQuestionInputRegistry()
    const onKey = mock(() => true)
    const onPaste = mock(() => {})
    registry.register({ onKey, onPaste })
    registry.clear()

    expect(registry.input({ name: "escape" })).toBe(false)
    expect(registry.paste("text")).toBe(false)
    expect(onKey).not.toHaveBeenCalled()
    expect(onPaste).not.toHaveBeenCalled()
  })
})

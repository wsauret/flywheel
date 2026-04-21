import { describe, it, expect } from "bun:test"
import type { MouseEvent as TuiMouseEvent } from "@opentui/core"
import { preventSelectionMouseDown } from "../../src/tui/utils/mouse.js"

describe("preventSelectionMouseDown", () => {
  it("prevents the default mouse selection before running the action", () => {
    const calls: string[] = []
    const handler = preventSelectionMouseDown(() => calls.push("action"))

    handler({ preventDefault: () => calls.push("preventDefault") } as TuiMouseEvent)

    expect(calls).toEqual(["preventDefault", "action"])
  })
})

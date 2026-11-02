import { describe, expect, it, mock } from "bun:test"
import { createRoot } from "solid-js"
import { createModalStack } from "../../../../src/tui/components/modal-stack.js"
import { useHelpModal } from "../../../../src/tui/hooks/use-help-modal.js"

describe("useHelpModal", () => {
  it("routes row and page keys to the reference scrollbox", () => createRoot((dispose) => {
    const modal = createModalStack()
    const hook = useHelpModal({ modal, renderModal: () => "help" })
    const scrollBy = mock((rows: number) => { void rows })
    const pageBy = mock((direction: number) => { void direction })
    hook.scroll.scrollBy = scrollBy
    hook.scroll.pageBy = pageBy

    hook.openHelpModal()
    modal.input({ name: "down" })
    modal.input({ name: "up" })
    modal.input({ name: "pagedown" })
    modal.input({ name: "pageup" })

    expect(scrollBy.mock.calls.map(([rows]) => rows)).toEqual([1, -1])
    expect(pageBy.mock.calls.map(([direction]) => direction)).toEqual([1, -1])
    dispose()
  }))

  it("closes on Enter or Escape", () => createRoot((dispose) => {
    const modal = createModalStack()
    const hook = useHelpModal({ modal, renderModal: () => "help" })

    hook.openHelpModal()
    modal.input({ name: "return" })
    expect(modal.stack).toHaveLength(0)

    hook.openHelpModal()
    modal.input({ name: "escape" })
    expect(modal.stack).toHaveLength(0)
    dispose()
  }))
})

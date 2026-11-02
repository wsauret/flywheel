import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { createModalStack, type ModalHandle } from "../../../../src/tui/components/modal-stack.js"
import { createSettingsTree } from "../../../../src/tui/hooks/settings-tree.js"

function createHarness() {
  const modal = createModalStack()
  const tree = createSettingsTree(modal)
  let rootHandle: ModalHandle | undefined
  tree.bindRoot({
    open: () => { rootHandle = modal.replace("settings-root") },
    isOpen: () => rootHandle?.isOpen() ?? false,
  })
  return { modal, tree }
}

describe("settings tree", () => {
  it("opens the settings root under a directly opened child", () => {
    createRoot((dispose) => {
      const { modal, tree } = createHarness()

      tree.childModal.replace("auth")

      expect(modal.stack.length).toBe(2)
      expect(modal.stack[0]?.element).toBe("settings-root")
      expect(modal.stack[1]?.element).toBe("auth")
      dispose()
    })
  })

  it("keeps an already open settings root and swaps a sibling child", () => {
    createRoot((dispose) => {
      const { modal, tree } = createHarness()
      tree.childModal.replace("auth")
      let siblingClosed = false

      tree.childModal.replace("theme", { onClose: () => { siblingClosed = true } })
      tree.childModal.replace("models")
      tree.childModal.replace("profile")

      expect(modal.stack.map((entry) => entry.element)).toEqual(["settings-root", "profile"])
      expect(siblingClosed).toBe(true)
      dispose()
    })
  })

  it("pops a child back to the settings root and clears the whole stack", () => {
    createRoot((dispose) => {
      const { modal, tree } = createHarness()
      const child = tree.childModal.replace("auth")

      child.close()
      expect(modal.stack.map((entry) => entry.element)).toEqual(["settings-root"])

      tree.childModal.replace("auth")
      tree.childModal.clear()
      expect(modal.stack.length).toBe(0)
      dispose()
    })
  })

  it("replaces a non-tree modal with a fresh root and child", () => {
    createRoot((dispose) => {
      const { modal, tree } = createHarness()
      modal.replace("sessions")

      tree.childModal.replace("auth")

      expect(modal.stack.map((entry) => entry.element)).toEqual(["settings-root", "auth"])
      dispose()
    })
  })
})

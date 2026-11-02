import { describe, expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createComposerHistoryPopup, type ComposerHistoryPopupHook } from "../../../../src/tui/hooks/create-composer-history-popup.js"

function withHook(
  initial: readonly string[],
  run: (hook: ComposerHistoryPopupHook, setEntries: (entries: readonly string[]) => void) => void,
): void {
  createRoot((dispose) => {
    const [entries, setEntries] = createSignal(initial)
    run(createComposerHistoryPopup({ entries }), setEntries)
    dispose()
  })
}

describe("createComposerHistoryPopup", () => {
  it("starts closed and opens on the newest (last) entry", () => {
    withHook(["a", "b", "c"], (hook) => {
      expect(hook.visible()).toBe(false)
      hook.open()
      expect(hook.visible()).toBe(true)
      expect(hook.selectedIndex()).toBe(2)
      expect(hook.rows()[2]).toBe("c")
    })
  })

  it("stays closed when the history is empty", () => {
    withHook([], (hook) => {
      hook.open()
      expect(hook.visible()).toBe(false)
    })
  })

  it("derives rows oldest-first with the original exact text", () => {
    const multiline = "line one\n  line two"
    withHook(["oldest", multiline], (hook) => {
      expect(hook.rows()).toEqual(["oldest", multiline])
    })
  })

  it("rows are reactive: a new entry appears at the end", () => {
    withHook(["a"], (hook, setEntries) => {
      expect(hook.rows()).toEqual(["a"])
      setEntries(["a", "b"])
      expect(hook.rows()).toEqual(["a", "b"])
    })
  })

  it("moveSelection clamps at both ends without wrapping", () => {
    withHook(["a", "b", "c"], (hook) => {
      hook.open()
      hook.moveSelection(1)
      expect(hook.selectedIndex()).toBe(2)
      hook.moveSelection(-1)
      hook.moveSelection(-1)
      expect(hook.selectedIndex()).toBe(0)
      hook.moveSelection(-1)
      expect(hook.selectedIndex()).toBe(0)
    })
  })

  it("select sets an absolute index and ignores out-of-range indices", () => {
    withHook(["a", "b", "c"], (hook) => {
      hook.open()
      hook.select(2)
      expect(hook.selectedIndex()).toBe(2)
      hook.select(3)
      expect(hook.selectedIndex()).toBe(2)
      hook.select(-1)
      expect(hook.selectedIndex()).toBe(2)
    })
  })

  it("close resets the selection and reopening starts at the newest entry", () => {
    withHook(["a", "b", "c"], (hook) => {
      hook.open()
      hook.moveSelection(-1)
      hook.close()
      expect(hook.visible()).toBe(false)
      hook.open()
      expect(hook.selectedIndex()).toBe(2)
    })
  })

  it("clamps the selection when entries shrink while open", () => {
    withHook(["a", "b", "c"], (hook, setEntries) => {
      hook.open()
      hook.select(2)
      setEntries(["a"])
      expect(hook.selectedIndex()).toBe(0)
    })
  })
})

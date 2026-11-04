import { describe, expect, test, mock } from "bun:test"
import { createRoot } from "solid-js"
import { createModalStack, createOverlayLayers } from "../../../../src/tui/components/modal-stack.js"

describe("modals stack", () => {
  test("explicit dismissal removes only the top nested entry", () => {
    createRoot((dispose) => {
      const stack = createModalStack()
      const firstClose = mock(() => {})
      const secondClose = mock(() => {})
      stack.push("first", { onClose: firstClose })
      // oxlint-disable-next-line unicorn/prefer-single-call -- the modal stack takes one modal per call, not Array#push arguments
      stack.push("second", { onClose: secondClose })

      expect(stack.dismiss()).toBe(true)
      expect(stack.stack.length).toBe(1)
      expect(secondClose).toHaveBeenCalledTimes(1)
      expect(firstClose).not.toHaveBeenCalled()
      dispose()
    })
  })

  test("replace clears previous entries and fires their onClose", () => {
    createRoot((dispose) => {
      const stack = createModalStack()
      const onClose1 = mock(() => {})
      stack.replace("content-a", { onClose: onClose1 })
      stack.replace("content-b")
      expect(stack.stack.length).toBe(1)
      expect(stack.stack[0]?.element).toBe("content-b")
      expect(onClose1).toHaveBeenCalledTimes(1)
      dispose()
    })
  })

  test("pop removes the top entry and fires its onClose", () => {
    createRoot((dispose) => {
      const stack = createModalStack()
      const onClose = mock(() => {})
      stack.replace("content", { onClose })
      stack.pop()
      expect(stack.stack.length).toBe(0)
      expect(onClose).toHaveBeenCalledTimes(1)
      dispose()
    })
  })

  test("input routes to top-of-stack key handler", () => {
    createRoot((dispose) => {
      const onKey = mock(() => {})
      const stack = createModalStack()
      stack.replace("content", { onKey })
      const handled = stack.input({ name: "escape" })
      expect(handled).toBe(true)
      expect(onKey).toHaveBeenCalledTimes(1)
      dispose()
    })
  })

  test("a stale handle cannot close a replacement", () => {
    createRoot((dispose) => {
      const stack = createModalStack()
      const stale = stack.replace("content-a")
      stack.replace("content-b")

      expect(stale.close()).toBe(false)
      expect(stale.isOpen()).toBe(false)
      expect(stack.stack.length).toBe(1)
      expect(stack.stack[0]?.element).toBe("content-b")
      dispose()
    })
  })

  test("a reentrant close callback runs once and repeated close is a no-op", () => {
    createRoot((dispose) => {
      const stack = createModalStack()
      let closes = 0
      const handle = stack.replace("content", {
        onClose: () => {
          closes += 1
          handle.close()
        },
      })

      expect(handle.close()).toBe(true)
      expect(handle.close()).toBe(false)
      expect(closes).toBe(1)
      expect(stack.stack.length).toBe(0)
      dispose()
    })
  })

  test("a handle reports open only while its own entry is on the stack", () => {
    createRoot((dispose) => {
      const stack = createModalStack()
      const handle = stack.replace("content")
      expect(handle.isOpen()).toBe(true)
      stack.clear()
      expect(handle.isOpen()).toBe(false)
      dispose()
    })
  })

  test("a handle reports whether its own entry is on top", () => {
    createRoot((dispose) => {
      const stack = createModalStack()
      const first = stack.push("first")
      const second = stack.push("second")

      expect(first.isTop()).toBe(false)
      expect(second.isTop()).toBe(true)
      second.close()
      expect(first.isTop()).toBe(true)
      first.close()
      expect(first.isTop()).toBe(false)
      dispose()
    })
  })
})

describe("overlay layers", () => {
  test("keeps covered dialogs as Back history without making them current", () => {
    createRoot((dispose) => {
      const overlays = createOverlayLayers()
      overlays.dialog.push("settings")
      // oxlint-disable-next-line unicorn/prefer-single-call -- the overlay layer takes one dialog per call, not Array#push arguments
      overlays.dialog.push("auth")

      expect(overlays.dialog.stack.at(-1)?.element).toBe("auth")
      overlays.dialog.pop()
      expect(overlays.dialog.stack.at(-1)?.element).toBe("settings")
      dispose()
    })
  })

  test("routes input to the highest layer and falls back after it closes", () => {
    createRoot((dispose) => {
      const overlays = createOverlayLayers()
      const viewerKey = mock(() => {})
      const viewerPaste = mock(() => {})
      const dialogKey = mock(() => {})
      const dialogPaste = mock(() => {})
      overlays.viewer.replace("viewer", { onKey: viewerKey, onPaste: viewerPaste })
      overlays.dialog.replace("dialog", { onKey: dialogKey, onPaste: dialogPaste })

      expect(overlays.input({ name: "a" })).toBe(true)
      expect(overlays.paste("dialog text")).toBe(true)
      expect(dialogKey).toHaveBeenCalledTimes(1)
      expect(dialogPaste).toHaveBeenCalledTimes(1)
      expect(viewerKey).not.toHaveBeenCalled()
      expect(viewerPaste).not.toHaveBeenCalled()

      overlays.dialog.pop()
      expect(overlays.input({ name: "b" })).toBe(true)
      expect(overlays.paste("viewer text")).toBe(true)
      expect(viewerKey).toHaveBeenCalledTimes(1)
      expect(viewerPaste).toHaveBeenCalledTimes(1)
      dispose()
    })
  })

  test("a handlerless highest layer consumes input without falling through", () => {
    createRoot((dispose) => {
      const overlays = createOverlayLayers()
      const viewerKey = mock(() => {})
      const viewerPaste = mock(() => {})
      overlays.viewer.replace("viewer", { onKey: viewerKey, onPaste: viewerPaste })
      overlays.dialog.replace("model-like dialog")

      expect(overlays.input({ name: "escape" })).toBe(true)
      expect(overlays.paste("ignored")).toBe(true)
      expect(viewerKey).not.toHaveBeenCalled()
      expect(viewerPaste).not.toHaveBeenCalled()

      overlays.clear()
      overlays.viewer.replace("handlerless viewer")
      expect(overlays.input({ name: "escape" })).toBe(true)
      expect(overlays.paste("ignored by viewer")).toBe(true)

      overlays.clear()
      expect(overlays.input({ name: "escape" })).toBe(false)
      expect(overlays.paste("unhandled")).toBe(false)
      dispose()
    })
  })

  test("viewer push and replace clear dialogs while preserving viewer history semantics", () => {
    createRoot((dispose) => {
      const overlays = createOverlayLayers()
      const firstDialogClose = mock(() => {})
      const secondDialogClose = mock(() => {})
      overlays.dialog.replace("first dialog", { onClose: firstDialogClose })
      overlays.viewer.push("first viewer")

      expect(firstDialogClose).toHaveBeenCalledTimes(1)
      expect(overlays.dialog.stack).toHaveLength(0)
      expect(overlays.viewer.stack.map((entry) => entry.element)).toEqual(["first viewer"])

      overlays.dialog.replace("second dialog", { onClose: secondDialogClose })
      overlays.viewer.push("second viewer")
      expect(secondDialogClose).toHaveBeenCalledTimes(1)
      expect(overlays.viewer.stack.map((entry) => entry.element)).toEqual(["first viewer", "second viewer"])

      overlays.dialog.replace("third dialog")
      overlays.viewer.replace("replacement viewer")
      expect(overlays.dialog.stack).toHaveLength(0)
      expect(overlays.viewer.stack.map((entry) => entry.element)).toEqual(["replacement viewer"])
      dispose()
    })
  })

  test("distinguishes the active viewer from the focused viewer", () => {
    createRoot((dispose) => {
      const overlays = createOverlayLayers()
      const draft = { text: "preserved draft" }
      const viewer = () => draft.text
      const first = overlays.viewer.push(viewer)
      const second = overlays.viewer.push("second viewer")

      expect(first.isActive()).toBe(false)
      expect(first.isFocused()).toBe(false)
      expect(second.isActive()).toBe(true)
      expect(second.isFocused()).toBe(true)

      overlays.dialog.push("model dialog")
      expect(second.isActive()).toBe(true)
      expect(second.isFocused()).toBe(false)
      overlays.dialog.pop()

      expect(second.isFocused()).toBe(true)
      second.close()
      expect(first.isActive()).toBe(true)
      expect(first.isFocused()).toBe(true)
      expect(overlays.viewer.stack.at(-1)?.element).toBe(viewer)
      expect(draft.text).toBe("preserved draft")
      dispose()
    })
  })

  test("clear closes dialogs before viewers exactly once and leaves stale handles inert", () => {
    createRoot((dispose) => {
      const overlays = createOverlayLayers()
      const order: string[] = []
      const staleDialog = overlays.dialog.replace("dialog", { onClose: () => order.push("dialog") })
      const currentDialog = overlays.dialog.replace("replacement dialog", { onClose: () => order.push("replacement dialog") })

      expect(staleDialog.close()).toBe(false)
      expect(currentDialog.isOpen()).toBe(true)
      const staleViewer = overlays.viewer.replace("viewer", { onClose: () => order.push("viewer") })
      const currentViewer = overlays.viewer.replace("replacement viewer", { onClose: () => order.push("replacement viewer") })
      overlays.dialog.replace("top dialog", { onClose: () => order.push("top dialog") })

      expect(staleViewer.close()).toBe(false)
      expect(currentViewer.isOpen()).toBe(true)
      overlays.clear()
      overlays.clear()

      expect(order).toEqual(["dialog", "replacement dialog", "viewer", "top dialog", "replacement viewer"])
      expect(currentDialog.close()).toBe(false)
      expect(currentViewer.close()).toBe(false)
      dispose()
    })
  })

  test("reports open when either layer has an entry", () => {
    createRoot((dispose) => {
      const overlays = createOverlayLayers()
      expect(overlays.isOpen()).toBe(false)
      overlays.dialog.push("dialog")
      expect(overlays.isOpen()).toBe(true)
      overlays.clear()
      overlays.viewer.push("viewer")
      expect(overlays.isOpen()).toBe(true)
      overlays.clear()
      expect(overlays.isOpen()).toBe(false)
      dispose()
    })
  })

  test("names the route of the topmost modal that has one, a dialog before a viewer", () => {
    createRoot((dispose) => {
      const overlays = createOverlayLayers()
      expect(overlays.route()).toEqual({ kind: "none" })
      overlays.viewer.push("child", { route: { kind: "child", sessionId: "child-1" } })
      expect(overlays.route()).toEqual({ kind: "child", sessionId: "child-1" })
      overlays.dialog.push("sessions", { route: { kind: "sessions" } })
      // oxlint-disable-next-line unicorn/prefer-single-call -- the overlay layer takes one dialog per call, not Array#push arguments
      overlays.dialog.push("confirm")
      expect(overlays.route()).toEqual({ kind: "sessions" })
      overlays.dialog.clear()
      expect(overlays.route()).toEqual({ kind: "child", sessionId: "child-1" })
      dispose()
    })
  })
})

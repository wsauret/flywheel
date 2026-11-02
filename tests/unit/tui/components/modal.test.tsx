/** @jsxImportSource @opentui/solid */

import { beforeEach, describe, expect, it, mock } from "bun:test"

const copy = mock(async (_text: string) => {})
// The modals holds no clipboard of its own: the shell injects one, so the test
// injects a fake with the same surface.
const clipboard = { copy, readImage: async () => null }

const { testRender } = await import("@opentui/solid")
const { onMount } = await import("solid-js")
const { onCleanup } = await import("solid-js")
const { createComponent } = await import("solid-js/web")
const { ModalProvider, useModal, useOverlay } = await import("../../../../src/tui/components/modal.js")
const { ModalFrame } = await import("../../../../src/tui/components/modal-frame.js")
const { QuestionInputProvider } = await import("../../../../src/tui/components/question-input.js")
const { ThemeProvider } = await import("../../../../src/tui/context/theme.js")
const { ToastProvider } = await import("../../../../src/tui/context/toast.js")

let modalSize = (): number => 0
let openHarnessModal = (): void => {}
let openHarnessViewer = (): void => {}
let pushHarnessModal = (): void => {}
let popHarnessModal = (): void => {}
let mountedBodies = 0
let disposedBodies = 0
let mountedDialogs = 0
let disposedDialogs = 0
function ViewerBody() {
  mountedBodies++
  onCleanup(() => disposedBodies++)
  return <box height={7}><text>Viewer body</text></box>
}
function DialogBody() {
  mountedDialogs++
  onCleanup(() => disposedDialogs++)
  return <text>Modal body</text>
}
function Harness(props: { autoOpen: boolean }) {
  const modals = useModal()
  const overlays = useOverlay()
  modalSize = () => modals.stack.length
  const open = () => {
    modals.replace(() => (
      <ModalFrame title="Settings" width={24} onClose={() => modals.clear()}>
        <DialogBody />
      </ModalFrame>
    ))
  }
  openHarnessViewer = () => {
    overlays.viewer.replace(() => (
      <ModalFrame title="Subagent" width={32} onClose={() => overlays.viewer.clear()}>
        <ViewerBody />
      </ModalFrame>
    ))
  }
  openHarnessModal = open
  pushHarnessModal = () => { modals.push(() => <ModalFrame title="Models" width={24} onClose={() => modals.pop()}><text>Model picker</text></ModalFrame>) }
  popHarnessModal = () => modals.pop()
  onMount(() => {
    if (props.autoOpen) open()
  })
  return <text>UNDERLYING_MARKER</text>
}

function renderModal(options: { autoOpen?: boolean } = {}) {
  return testRender(() =>
    createComponent(ToastProvider, {
      get children() {
        return createComponent(ThemeProvider, {
          mode: "dark",
          get children() {
            return createComponent(QuestionInputProvider, {
              get children() {
                return createComponent(ModalProvider, {
                  clipboard,
                  get children() {
                    return createComponent(Harness, { autoOpen: options.autoOpen ?? true })
                  },
                })
              },
            })
          },
        })
      },
    }),
  { width: 40, height: 12 })
}

describe("ModalProvider", () => {
  beforeEach(() => copy.mockClear())

  it("keeps a covered viewer mounted and restores the same body after pop", async () => {
    mountedBodies = 0
    disposedBodies = 0
    const result = await renderModal({ autoOpen: false })
    try {
      openHarnessViewer()
      await result.renderOnce()
      pushHarnessModal()
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Model picker")
      expect(result.captureCharFrame()).toContain("Subagent")
      expect(disposedBodies).toBe(0)
      popHarnessModal()
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Viewer body")
      expect(mountedBodies).toBe(1)
    } finally { result.renderer.destroy() }
  })

  it("renders only the current dialog while preserving Back history", async () => {
    mountedDialogs = 0
    disposedDialogs = 0
    const result = await renderModal({ autoOpen: false })
    try {
      openHarnessModal()
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Modal body")

      pushHarnessModal()
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Model picker")
      expect(result.captureCharFrame()).not.toContain("Modal body")
      expect(disposedDialogs).toBe(1)

      popHarnessModal()
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Modal body")
      expect(result.captureCharFrame()).not.toContain("Model picker")
      expect(mountedDialogs).toBe(2)
    } finally { result.renderer.destroy() }
  })

  it("opening a viewer clears an existing dialog", async () => {
    const result = await renderModal()
    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Modal body")

      openHarnessViewer()
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Viewer body")
      expect(result.captureCharFrame()).not.toContain("Modal body")
      expect(modalSize()).toBe(0)
    } finally { result.renderer.destroy() }
  })

  it("keeps the underlying frame visible behind the scrim while a modal is open", async () => {
    const result = await renderModal()

    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("Modal body")
      // The backdrop paints nothing: the frame behind the modal stays exactly
      // as rendered, never dimmed or blanked.
      expect(frame).toContain("UNDERLYING_MARKER")
    } finally {
      result.renderer.destroy()
    }
  })

  it("copies and clears text selected inside a modal", async () => {
    const result = await renderModal()

    try {
      await result.renderOnce()
      await result.mockMouse.drag(11, 6, 21, 6)
      await Promise.resolve()

      expect(result.renderer.getSelection()?.getSelectedText() ?? "").toBe("")
      expect(copy).toHaveBeenCalledTimes(1)
      expect(copy.mock.calls[0]?.[0]).toContain("Modal body")
    } finally {
      result.renderer.destroy()
    }
  })

  it("keeps the modal open when the press and release both land on the backdrop", async () => {
    const result = await renderModal()

    try {
      await result.renderOnce()
      await result.mockMouse.pressDown(0, 0)
      await result.mockMouse.release(0, 0)
      // Backdrop clicks are inert: dismissal is only escape or the frame's x.
      expect(modalSize()).toBe(1)
    } finally {
      result.renderer.destroy()
    }
  })

  it("cannot start a highlight on background text while a modal is open", async () => {
    const result = await renderModal()

    try {
      await result.renderOnce()
      // UNDERLYING_MARKER renders at the top-left, behind the scrim.
      await result.mockMouse.drag(1, 0, 15, 0)
      await Promise.resolve()
      expect(result.renderer.getSelection()?.getSelectedText() ?? "").toBe("")
      expect(copy).not.toHaveBeenCalled()
    } finally {
      result.renderer.destroy()
    }
  })

  it("drops a background highlight made before the modal opened", async () => {
    const result = await renderModal({ autoOpen: false })

    try {
      await result.renderOnce()
      await result.mockMouse.drag(1, 0, 15, 0)
      await Promise.resolve()
      expect(result.renderer.getSelection()?.getSelectedText() ?? "").not.toBe("")

      openHarnessModal()
      await result.renderOnce()
      // Everything under the modal is background; nothing outside it stays lit.
      expect(result.renderer.getSelection()?.getSelectedText() ?? "").toBe("")
    } finally {
      result.renderer.destroy()
    }
  })
})

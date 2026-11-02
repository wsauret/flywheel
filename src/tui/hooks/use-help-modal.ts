import type { JSX } from "solid-js"
import { createModalScrollController, type ModalScrollController } from "../components/modal-scroll-controller.js"
import type { ModalContext } from "../components/modal-stack.js"

interface HelpModalDeps {
  modal: ModalContext
  renderModal: (scroll: ModalScrollController) => JSX.Element
}

export function useHelpModal(deps: HelpModalDeps) {
  const scroll = createModalScrollController()

  function handleKey(event: { name: string; preventDefault?: () => void }): void {
    const key = event.name.toLowerCase()
    if (key === "escape" || key === "enter" || key === "return") {
      event.preventDefault?.()
      deps.modal.clear()
      return
    }
    if (key === "up" || key === "down") {
      event.preventDefault?.()
      scroll.scrollBy(key === "up" ? -1 : 1)
      return
    }
    if (key === "pageup" || key === "pagedown") {
      event.preventDefault?.()
      scroll.pageBy(key === "pageup" ? -1 : 1)
    }
  }

  function openHelpModal(): void {
    scroll.reset()
    deps.modal.replace(() => deps.renderModal(scroll), { onKey: handleKey, onClose: scroll.reset })
  }

  return { openHelpModal, scroll }
}

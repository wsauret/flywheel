import type { MouseEvent } from "@opentui/core"
import type { TranscriptSelectionAutoScroll } from "./create-output-scroll-controller.js"

interface SelectionStateReader {
  readonly getSelection: () => { readonly isDragging: boolean } | null
}

export interface TranscriptSelectionDrag {
  readonly register: (controller: TranscriptSelectionAutoScroll) => () => void
  readonly onMouseDown: (event: MouseEvent) => void
  readonly onMouseDrag: (event: MouseEvent) => void
  readonly onMouseUp: () => void
}

/** Routes a transcript-owned selection after the pointer enters sibling shell regions. */
export function createTranscriptSelectionDrag(renderer: SelectionStateReader): TranscriptSelectionDrag {
  let controller: TranscriptSelectionAutoScroll | undefined
  let dragging = false

  function register(next: TranscriptSelectionAutoScroll): () => void {
    controller?.stop()
    controller = next
    dragging = false
    return () => {
      next.stop()
      if (controller !== next) return
      controller = undefined
      dragging = false
    }
  }

  function onMouseDown(event: MouseEvent): void {
    controller?.stop()
    dragging = event.button === 0
      && renderer.getSelection()?.isDragging === true
      && controller?.contains(event.target) === true
  }

  function onMouseDrag(event: MouseEvent): void {
    if (dragging) controller?.update(event.x, event.y)
  }

  function onMouseUp(): void {
    controller?.stop()
    dragging = false
  }

  return { register, onMouseDown, onMouseDrag, onMouseUp }
}

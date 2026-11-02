import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { HydratedOutputBlockBody } from "../../../src/protocol/transcript-protocol-types.js"
import "../styles/image-viewer.css"

type AttachmentImage = NonNullable<HydratedOutputBlockBody["images"]>[number]

/** A native modal keeps focus and the retained image independent of transcript layout. */
export function ImageViewer(props: { image: AttachmentImage; label: string; onClose: () => void }) {
  let dialog!: HTMLDialogElement
  let viewport!: HTMLDivElement
  const [zoom, setZoom] = createSignal(1)
  const [natural, setNatural] = createSignal({ width: 0, height: 0 })
  const [bounds, setBounds] = createSignal({ width: 0, height: 0 })
  const width = createMemo(() => {
    const size = natural()
    const area = bounds()
    if (!size.width || !size.height) return undefined
    const fitted = Math.min(size.width, area.width, area.height * size.width / size.height)
    return `${fitted * zoom()}px`
  })
  const reset = () => { setZoom(1); viewport.scrollTo({ left: 0, top: 0, behavior: "instant" }) }
  onMount(() => {
    const observer = new ResizeObserver(() => setBounds({ width: viewport.clientWidth, height: viewport.clientHeight }))
    observer.observe(viewport)
    dialog.showModal()
    viewport.focus()
    onCleanup(() => { observer.disconnect(); dialog.close() })
  })
  return <dialog ref={(element) => { dialog = element }} class="image-viewer" aria-label={props.label}
    onCancel={(event) => { event.preventDefault(); props.onClose() }}
    onKeyDown={(event) => {
      if (event.key === "+" || event.key === "=") { event.preventDefault(); setZoom((value) => Math.min(16, value * 2)) }
      else if (event.key === "-") { event.preventDefault(); setZoom((value) => Math.max(0.25, value / 2)) }
      else if (event.key === "0") { event.preventDefault(); reset() }
    }}>
    <header class="image-viewer-header">
      <strong>{props.label}</strong>
      <button class="ghost-text" aria-label="Close image" onClick={props.onClose}>Close</button>
    </header>
    <div ref={(element) => { viewport = element }} class="image-viewer-viewport" tabIndex={0} aria-label="Image, scroll to inspect">
      <img src={`data:${props.image.mediaType};base64,${props.image.data}`} alt={props.label}
        style={{ width: width() }}
        onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
    </div>
    <footer class="image-viewer-controls">
      <button class="ghost-text" aria-label="Zoom out" disabled={zoom() <= 0.25} onClick={() => setZoom((value) => Math.max(0.25, value / 2))}>-</button>
      <button class="ghost-text" onClick={reset}>Fit</button>
      <button class="ghost-text" aria-label="Zoom in" disabled={zoom() >= 16} onClick={() => setZoom((value) => Math.min(16, value * 2))}>+</button>
    </footer>
  </dialog>
}

import { onCleanup, onMount, Show, type JSX } from "solid-js"
import { scrollEdges } from "./scroll-edges.js"
import { Icon, ICONS } from "./icons.js"
import { Sheet } from "./sheets/sheet.js"
import "../styles/workspace-panel.css"

/** Shares content between a modal sheet and a non-modal, independently scrolling panel. */
export function WorkspaceSurface(props: {
  readonly title: string
  readonly docked?: boolean
  readonly wide?: boolean
  readonly onClose: () => void
  readonly tools?: JSX.Element
  readonly children: JSX.Element
  readonly contentRef?: (element: HTMLDivElement) => void
}) {
  return <Show when={props.docked} fallback={<Sheet title={props.title} wide={props.wide} onClose={props.onClose} tools={props.tools} contentRef={props.contentRef}>{props.children}</Sheet>}>
    <WorkspacePanel title={props.title} onClose={props.onClose} tools={props.tools} contentRef={props.contentRef}>{props.children}</WorkspacePanel>
  </Show>
}

function WorkspacePanel(props: { readonly title: string; readonly onClose: () => void; readonly tools?: JSX.Element; readonly children: JSX.Element; readonly contentRef?: (element: HTMLDivElement) => void }) {
  let close!: HTMLButtonElement
  onMount(() => {
    // The panel takes the keyboard as it opens, the way a sheet does, so
    // Escape closes it at once and never reaches the transcript's interrupt.
    // It traps nothing, and the keyboard returns to where it came from.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    close.focus({ preventScroll: true })
    onCleanup(() => { if (opener?.isConnected) opener.focus({ preventScroll: true }) })
  })
  return <aside class="workspace-panel" aria-label={props.title} onKeyDown={event => {
    if (event.key !== "Escape") return
    event.preventDefault()
    event.stopPropagation()
    props.onClose()
  }}>
    <header class="sheet-header">
      <h2 class="sheet-title">{props.title}</h2>
      <Show when={props.tools}><div class="sheet-tools">{props.tools}</div></Show>
      <button class="ghost" ref={element => { close = element }} title="Close panel" aria-label="Close panel" onClick={props.onClose}><Icon path={ICONS.close} /></button>
    </header>
    <div class="sheet-body workspace-panel-body scroll-edges" ref={scrollEdges}>
      <div ref={element => props.contentRef?.(element)}>{props.children}</div>
    </div>
  </aside>
}

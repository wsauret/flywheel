import { createEffect, createMemo, on, Show, type JSX } from "solid-js"

import { trapFocus } from "../focus-trap.js"
import { scrollEdges } from "../scroll-edges.js"
import { Icon, ICONS } from "../icons.js"
import "../../styles/sheets.css"

/** The frame every client sheet renders in.
 *
 *  On a narrow container it rises from the bottom and takes the full width,
 *  which is what a thumb reaches; on a wide one it floats centred like a
 *  dialog. The switch is a container query in the stylesheet, so the component
 *  knows nothing about where it is. Escape and the scrim close it, focus stays
 *  inside it, and the body scrolls on its own so the header never leaves. */
export function Sheet(props: {
  readonly title: string
  readonly onClose: () => void
  /** A row of controls beside the title: a refresh button, a filter. */
  readonly tools?: JSX.Element
  readonly children: JSX.Element
  /** Gives an imperative row-order owner the existing content parent, without another wrapper. */
  readonly contentRef?: (element: HTMLDivElement) => void
  /** Actions pinned under the body, for sheets that commit. */
  readonly footer?: JSX.Element
  /** Takes the wider frame where the container allows one, for a body made of
   *  code lines rather than rows. */
  readonly wide?: boolean
  /** Names the page a sheet with several pages shows. The body keeps each
   *  page's scroll position, so a return from a sub-page lands where the
   *  person left. */
  readonly place?: string
}) {
  let root: HTMLElement | undefined
  let body: HTMLDivElement | undefined
  trapFocus(() => root)
  const offsets = new Map<string, number>()
  const remember = () => { if (body !== undefined && props.place !== undefined) offsets.set(props.place, body.scrollTop) }
  // The new page has rendered when this runs, so its saved offset applies to its own content.
  // A memo, so a page that re-renders under the same name keeps its offset.
  const place = createMemo(() => props.place)
  createEffect(on(place, (shown) => { if (body !== undefined && shown !== undefined) body.scrollTop = offsets.get(shown) ?? 0 }, { defer: true }))
  return (
    <div class="scrim sheet-scrim" onClick={(event) => { if (event.target === event.currentTarget) props.onClose() }}>
      <section
        class="sheet"
        classList={{ "sheet-wide": props.wide === true }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        ref={(el) => (root = el)}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); props.onClose() } }}
      >
        <header class="sheet-header">
          <h2 class="sheet-title" id="sheet-title">{props.title}</h2>
          <Show when={props.tools}><div class="sheet-tools">{props.tools}</div></Show>
          <button class="ghost" title="Close" aria-label="Close" onClick={props.onClose}>
            <Icon path={ICONS.close} />
          </button>
        </header>
        <div class="sheet-body scroll-edges" ref={(el) => { body = el; scrollEdges(el) }} onScroll={remember}><div ref={element => props.contentRef?.(element)}>{props.children}</div></div>
        <Show when={props.footer}><footer class="sheet-footer">{props.footer}</footer></Show>
      </section>
    </div>
  )
}

/** One labelled row inside a sheet: a name, a value, and optionally something
 *  to do about it. The same grammar the command panel uses, so a reading in a
 *  sheet and a setting in the panel look like the same kind of thing. */
export function SheetRow(props: {
  readonly label: JSX.Element
  readonly value?: JSX.Element
  readonly detail?: JSX.Element
  /** Marks the visible detail as incomplete without changing layout. */
  readonly detailBusy?: boolean
  /** Marks the visible value as incomplete without changing layout. */
  readonly valueBusy?: boolean
  readonly tone?: "ok" | "warn" | "error"
  readonly onClick?: () => void
  /** What Enter on the focused row does when it differs from a tap, such as
   *  opening what the row names while a tap shows where it is. */
  readonly onEnter?: () => void
  /** Suppresses activation and exposes aria-disabled while the row remains mounted and focusable. */
  readonly disabled?: boolean
  /** True while the row's action waits on the runtime. The row stays active:
   *  a second tap joins the running action. */
  readonly working?: boolean
  /** Receives the row's focusable element so the owner can restore focus when the row is removed. */
  readonly rowRef?: (element: HTMLElement) => void
  readonly children?: JSX.Element
}) {
  const body = (
    <>
      <span class="sheet-row-main">
        <span class="sheet-row-label" classList={{ [`tone-${props.tone ?? "plain"}`]: true }}>{props.label}</span>
        <Show when={props.detail}><span class="sheet-row-detail" aria-busy={props.detailBusy || undefined}>{props.detail}</span></Show>
      </span>
      <Show when={props.value}><span class="sheet-row-value" aria-busy={props.valueBusy || undefined}>{props.value}</span></Show>
      {props.children}
    </>
  )
  const activate = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return
    event.preventDefault()
    if (props.disabled) return
    if (event.key === "Enter" && props.onEnter) props.onEnter()
    else props.onClick?.()
  }
  return (
    <Show when={props.onClick} fallback={<div class="sheet-row">{body}</div>}>
      <Show
        when={props.children}
        fallback={<button class="sheet-row sheet-row-button" ref={props.rowRef} aria-disabled={props.disabled || undefined} aria-busy={props.working || undefined} onClick={() => { if (!props.disabled) props.onClick?.() }}>{body}</button>}
      >
        <div class="sheet-row sheet-row-button" ref={props.rowRef} role="button" aria-disabled={props.disabled || undefined} aria-busy={props.working || undefined} tabIndex={0} onClick={() => { if (!props.disabled) props.onClick?.() }} onKeyDown={activate}>{body}</div>
      </Show>
    </Show>
  )
}

export function SheetEmpty(props: { readonly children: JSX.Element }) {
  return <div class="sheet-empty">{props.children}</div>
}

export function SheetLoading() {
  return <div class="sheet-empty" aria-busy="true">Reading…</div>
}

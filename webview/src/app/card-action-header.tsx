import { createEffect, createMemo, createSignal, Index, on, onCleanup, onMount, Show, type JSX } from "solid-js"
import { CARD_HOLD_MS, cardPressMoved } from "./card-press.js"

export const CARD_ACTION_COPY = {
  interrupt: { word: "Interrupt", meaning: "Cut it now. Resume continues it." },
  resume: { word: "Resume", meaning: "Continue it." },
  restart: { word: "Restart", meaning: "Run it again from its request." },
  stop: { word: "Stop", meaning: "End this run." },
}

export interface CardAction {
  readonly kind: keyof typeof CARD_ACTION_COPY
  readonly word: string
  readonly meaning: string
  readonly title: string
  readonly busyKey: string
  readonly run: () => void
}

/** One admitted action list drives the wide buttons and the header's action menu. */
export function CardActionHeader(props: {
  readonly class: string
  readonly actions: readonly CardAction[]
  readonly working: (key: string) => boolean
  readonly children: JSX.Element
}) {
  const [open, setOpen] = createSignal(false)
  const visible = createMemo(() => open() && props.actions.length > 0)
  let root!: HTMLDivElement
  let header!: HTMLDivElement
  let trigger: HTMLButtonElement | undefined
  let menu: HTMLDivElement | undefined
  let press: { x: number; y: number; id: number } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let releasePress: (() => void) | undefined
  let suppressClick = false
  const cancel = () => { clearTimeout(timer); timer = undefined; press = undefined; releasePress?.(); releasePress = undefined }
  const close = () => setOpen(false)
  const reveal = () => { if (props.actions.length) setOpen(true) }
  const run = (action: CardAction) => { close(); action.run() }
  createEffect(on(() => props.actions.length, length => { if (!length) close() }))

  onMount(() => {
    const document = root.ownerDocument
    const down = (event: PointerEvent) => {
      cancel()
      suppressClick = false
      if (!props.actions.length || event.button !== 0 || !event.isPrimary || !(event.target instanceof Element) || !event.target.closest(".disclosure")) return
      press = { x: event.clientX, y: event.clientY, id: event.pointerId }
      document.addEventListener("pointermove", move, true)
      document.addEventListener("pointerup", cancel, true)
      document.addEventListener("pointercancel", cancel, true)
      document.addEventListener("scroll", scroll, true)
      releasePress = () => {
        document.removeEventListener("pointermove", move, true)
        document.removeEventListener("pointerup", cancel, true)
        document.removeEventListener("pointercancel", cancel, true)
        document.removeEventListener("scroll", scroll, true)
      }
      timer = setTimeout(() => {
        if (press && props.actions.length) {
          suppressClick = true
          reveal()
        }
        cancel()
      }, CARD_HOLD_MS)
    }
    const move = (event: PointerEvent) => {
      if (press && (event.pointerId !== press.id || cardPressMoved(press, { x: event.clientX, y: event.clientY }))) cancel()
    }
    const context = (event: MouseEvent) => {
      if (!props.actions.length) return
      event.preventDefault()
      suppressClick = press !== undefined || suppressClick
      cancel()
      reveal()
    }
    // Touch activation calls click() from touchend. Capture it before the Open handler.
    const click = (event: MouseEvent) => {
      if (!suppressClick) return
      suppressClick = false
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const scroll = (event: Event) => {
      if (event.target === document || event.target instanceof Element && event.target.contains(header)) cancel()
    }
    header.addEventListener("pointerdown", down)
    header.addEventListener("contextmenu", context)
    header.addEventListener("click", click, true)
    onCleanup(() => {
      cancel()
      header.removeEventListener("pointerdown", down)
      header.removeEventListener("contextmenu", context)
      header.removeEventListener("click", click, true)
    })
  })
  createEffect(() => {
    if (!visible()) return
    const document = root.ownerDocument
    menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[0]?.focus()
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !root.contains(event.target)) close()
    }
    const key = (event: KeyboardEvent) => {
      const buttons = [...menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []]
      const focused = document.activeElement
      const index = focused instanceof HTMLElement ? buttons.indexOf(focused) : -1
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        close()
        trigger?.focus()
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
        event.preventDefault()
        event.stopPropagation()
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : event.key === "ArrowDown" ? (index + 1) % buttons.length : (index < 0 ? buttons.length - 1 : (index - 1 + buttons.length) % buttons.length)
        buttons[next]?.focus()
      } else if (event.key === "Tab") close()
    }
    document.addEventListener("pointerdown", outside)
    document.addEventListener("keydown", key, true)
    onCleanup(() => {
      document.removeEventListener("pointerdown", outside)
      document.removeEventListener("keydown", key, true)
    })
  })
  return <div class="card-action-header" ref={element => { root = element }}>
    <div class={`agent-group-head ${props.class}`} ref={element => { header = element }}>
      {props.children}
      <span class="card-inline-actions"><Index each={props.actions}>{action => <button type="button" class="workflow-action"
        aria-label={action().word} title={action().title} aria-busy={props.working(action().busyKey) || undefined}
        onClick={() => action().run()}>{action().word}</button>}</Index></span>
      <Show when={props.actions.length}><span class="card-actions-overlay">
        <button type="button" class="card-actions-trigger" ref={element => { trigger = element }} aria-label="Actions" aria-haspopup="menu" aria-expanded={open()}
          aria-busy={props.actions.some(action => props.working(action.busyKey)) || undefined}
          onClick={() => setOpen(value => !value)}>⋯</button>
      </span></Show>
    </div>
    <Show when={visible()}><div class="command-panel card-action-menu" role="menu" aria-label="Actions" ref={element => { menu = element }}>
      <div class="panel-scroll"><div class="panel-scroll-content">
        <Index each={props.actions}>{action => <button type="button" role="menuitem" class="panel-row" aria-label={action().word}
          aria-busy={props.working(action().busyKey) || undefined} onClick={() => run(action())}>
          <span class="panel-label">{action().word}</span><span class="card-action-meaning">{action().meaning}</span>
        </button>}</Index>
      </div></div>
    </div></Show>
  </div>
}

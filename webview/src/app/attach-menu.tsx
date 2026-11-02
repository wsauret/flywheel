import { createSignal, For, onCleanup, Show } from "solid-js"
import { scrollEdges } from "./scroll-edges.js"

export interface AttachMenuRow {
  readonly id: string
  readonly label: string
  /** Hover text. Never rendered in the list. */
  readonly description: string
  readonly run: () => void
}

interface AttachMenuDeps {
  readonly rows: readonly AttachMenuRow[]
}

/** The composer's `+` menu: the ways to put something into the message that
 *  is not typed, over the composer in the shape of the `/` and `@` panels. Static rows,
 *  no query: it is a menu a thumb opens, not a typeahead. It closes when a
 *  row runs, on Escape, or on a press anywhere outside it. Pointer presses
 *  retain the composer's focus. The menu captures keyboard actions while open. */
export function createAttachMenu(deps: AttachMenuDeps) {
  const [open, setOpen] = createSignal(false)
  const [active, setActive] = createSignal(0)
  let root: HTMLDivElement | undefined
  let anchor: HTMLElement | undefined

  const close = (): void => { setOpen(false) }
  const toggle = (): void => {
    setActive(0)
    setOpen(!open())
  }

  const pressOutside = (event: PointerEvent): void => {
    if (!open()) return
    const target = event.target
    if (target instanceof Node && (root?.contains(target) || anchor?.contains(target))) return
    close()
  }
  document.addEventListener("pointerdown", pressOutside)
  onCleanup(() => document.removeEventListener("pointerdown", pressOutside))

  const run = (row: AttachMenuRow): void => {
    close()
    row.run()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!open()) return
    const rows = deps.rows
    if (event.key === "ArrowDown") {
      event.preventDefault()
      event.stopPropagation()
      setActive((index) => (index + 1) % rows.length)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      event.stopPropagation()
      setActive((index) => (index - 1 + rows.length) % rows.length)
    } else if (event.key === "Enter" || event.key === " " || event.key === "Tab") {
      event.preventDefault()
      event.stopPropagation()
      const row = rows[active()]
      if (row !== undefined) run(row)
    } else if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }
  // Capture phase, so the menu answers before the field or the page would.
  document.addEventListener("keydown", onKeyDown, true)
  onCleanup(() => document.removeEventListener("keydown", onKeyDown, true))

  const view = () => (
    <Show when={open()}>
      <div class="command-panel attach-menu" role="menu" aria-label="Add to message" ref={(el) => (root = el)}>
        <div class="panel-scroll scroll-edges" ref={scrollEdges}>
          <div class="panel-scroll-content">
          <For each={deps.rows}>
            {(row, index) => (
              <button
                type="button"
                class="panel-row"
                role="menuitem"
                title={row.description}
                data-active={active() === index()}
                onMouseEnter={() => setActive(index())}
                onFocus={() => setActive(index())}
                onPointerDown={(event) => event.preventDefault()}
                onMouseDown={(event) => event.preventDefault()}
                // iOS requires click activation to open the native file chooser.
                onClick={() => run(row)}
              >
                <span class="panel-label">{row.label}</span>
              </button>
            )}
          </For>
          </div>
        </div>
      </div>
    </Show>
  )

  return {
    view,
    open,
    toggle,
    close,
    /** The control that opens the menu, so a press on it is not "outside". */
    attachAnchor: (element: HTMLElement) => { anchor = element },
  }
}

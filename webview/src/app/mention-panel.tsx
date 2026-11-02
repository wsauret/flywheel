import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js"
import { scrollEdges } from "./scroll-edges.js"

import type { ProjectFileEntry } from "../../../src/protocol/transcript-protocol-types.js"
import type { ClientContextValue } from "./client-context.js"
import type { MentionToken } from "../../../src/protocol/client/mention.js"

const DEBOUNCE_MS = 100
const ROW_LIMIT = 40

interface MentionPanelDeps {
  readonly client: ClientContextValue
  /** The token being typed, or undefined when the panel is closed. */
  readonly token: () => MentionToken | undefined
  readonly pick: (entry: ProjectFileEntry) => void
}

/** The composer's `@` panel: the project's files that match what follows
 *  the `@`, best match first, over the composer like the `/` panel. The
 *  runtime lists and ranks; this asks on each keystroke, shows, and inserts. */
export function createMentionPanel(deps: MentionPanelDeps) {
  // The files found and the query they answer, so the panel can tell a search
  // still on its way from an answer of no files.
  const [found, setFound] = createSignal<{ readonly query: string | undefined; readonly entries: readonly ProjectFileEntry[] }>({ query: undefined, entries: [] })
  const files = () => found().entries
  const searching = () => {
    const query = deps.token()?.query
    return query !== undefined && found().query !== query
  }
  const [active, setActive] = createSignal(0)
  let scroll: HTMLDivElement | undefined
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const open = () => deps.token() !== undefined

  createEffect(on(() => deps.token()?.query, (query) => {
    if (timer !== undefined) clearTimeout(timer)
    if (query === undefined) {
      setFound({ query: undefined, entries: [] })
      return
    }
    const mine = ++generation
    timer = setTimeout(() => {
      void deps.client.actions.projectFiles(query, ROW_LIMIT).then((entries) => {
        if (mine !== generation) return
        setFound({ query, entries })
        setActive(0)
      })
    }, DEBOUNCE_MS)
  }))
  onCleanup(() => { if (timer !== undefined) clearTimeout(timer) })

  createEffect(() => {
    active()
    scroll?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" })
  })

  const onKeyDown = (event: KeyboardEvent): boolean => {
    if (!open()) return false
    const rows = files()
    if (event.key === "ArrowDown" && rows.length > 0) {
      event.preventDefault()
      setActive((index) => (index + 1) % rows.length)
      return true
    }
    if (event.key === "ArrowUp" && rows.length > 0) {
      event.preventDefault()
      setActive((index) => (index - 1 + rows.length) % rows.length)
      return true
    }
    if ((event.key === "Enter" || event.key === "Tab") && rows.length > 0) {
      event.preventDefault()
      const entry = rows[active()]
      if (entry !== undefined) deps.pick(entry)
      return true
    }
    // Escape leaves the token as typed: the person may want a literal @.
    return false
  }

  const split = (path: string) => {
    const slash = path.lastIndexOf("/")
    return { dir: slash === -1 ? "" : path.slice(0, slash + 1), name: slash === -1 ? path : path.slice(slash + 1) }
  }

  const view = () => (
    <Show when={open() && (files().length > 0 || searching())}>
      <div class="command-panel mention-panel" role="listbox" aria-label="Project files" aria-busy={searching()}>
        <div class="panel-scroll scroll-edges" ref={(el) => { scroll = el; scrollEdges(el) }}>
          <div class="panel-scroll-content">
          <Show when={files().length === 0}>
            <div class="panel-section" role="status">Finding files…</div>
          </Show>
          <For each={files()}>
            {(entry, index) => (
              <div
                class="panel-row"
                role="option"
                aria-selected={active() === index()}
                data-active={active() === index()}
                onMouseEnter={() => setActive(index())}
                onPointerDown={(event) => event.preventDefault()}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => deps.pick(entry)}
              >
                <span class="panel-label">
                  <span class="mention-dir">{split(entry.path).dir}</span>
                  <span class="mention-name">{split(entry.path).name}{entry.directory ? "/" : ""}</span>
                </span>
              </div>
            )}
          </For>
          </div>
        </div>
      </div>
    </Show>
  )

  return { view, onKeyDown, open }
}

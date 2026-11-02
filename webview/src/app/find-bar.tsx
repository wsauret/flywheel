import { createEffect, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js"

import type { TranscriptSearchHit, TranscriptSearchResult } from "../../../src/protocol/transcript-protocol-types.js"
import { summaryOf } from "../client/view-state.js"
import { useClient } from "./client-context.js"
import { Icon, ICONS } from "./icons.js"
import { publishPaneHeight } from "./transcript-scroll.js"
import { scrollEdges } from "./scroll-edges.js"
import "../styles/find.css"
import { KERNEL_COMMAND_NAMES } from "../../../src/protocol/command-names.js"

const DEBOUNCE_MS = 200

/** Finding words in transcripts: a bar over the transcript with the query,
 *  the scope, and the count, and under it the ranked hits. Picking one lands
 *  the transcript on the block that holds it, in whichever session, and the
 *  bar and its hits stay so the next hit is one key away, as a desktop find
 *  bar stays. The runtime does the search; this only asks, shows, and steps. */
export function FindBar(props: { readonly query: string; readonly onClose: () => void }) {
  const client = useClient()
  // The query the bar opens with; the person edits it from there.
  const [query, setQuery] = createSignal(untrack(() => props.query))
  const [scope, setScope] = createSignal<"session" | "project">("session")
  const [result, setResult] = createSignal<TranscriptSearchResult | undefined>()
  const [hits, setHits] = createSignal<TranscriptSearchHit[]>([])
  const [active, setActive] = createSignal(-1)
  const [busy, setBusy] = createSignal(false)
  let input: HTMLInputElement | undefined
  let generation = 0

  const run = async (page: number): Promise<void> => {
    const text = query().trim()
    const sessionId = client.state().sessionId
    const mine = ++generation
    if (text.length === 0) {
      setResult(undefined)
      setHits([])
      setActive(-1)
      return
    }
    setBusy(true)
    try {
      const next = await client.actions.searchTranscripts({ query: text, page, ...(scope() === "session" && sessionId !== undefined ? { sessionId } : {}) })
      if (mine !== generation) return
      setResult(next)
      setHits(page === 1 ? [...next.hits] : [...hits(), ...next.hits])
      if (page === 1) setActive(next.hits.length > 0 ? 0 : -1)
    } finally {
      if (mine === generation) setBusy(false)
    }
  }
  // A search per keystroke would race its own answers; the last one wins
  // through the generation, and the pause keeps most of them from leaving.
  let timer: ReturnType<typeof setTimeout> | undefined
  createEffect(on([query, scope], () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => { void run(1) }, DEBOUNCE_MS)
  }, { defer: untrack(query).trim() === "" }))
  onCleanup(() => { if (timer !== undefined) clearTimeout(timer) })

  const open = async (index: number): Promise<void> => {
    const hit = hits()[index]
    if (!hit) return
    setActive(index)
    const blockId = await client.actions.openAround(hit.sessionId, hit.entryId)
    client.markBlock(blockId)
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault()
      props.onClose()
    } else if (event.key === "Enter") {
      event.preventDefault()
      void open(active() < 0 ? 0 : active())
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const count = hits().length
      if (count === 0) return
      const next = (active() + (event.key === "ArrowDown" ? 1 : count - 1)) % count
      void open(next)
    }
  }
  const more = () => {
    const current = result()
    return current !== undefined && hits().length < current.total
  }
  const roleLabel = (role: TranscriptSearchHit["role"]): string =>
    role === "user" ? "You" : role === "assistant" ? "Flywheel" : role === "tool" ? "Tool" : "Summary"
  /** The snippet's bracketed matches as emphasis; the rest as text. */
  const snippet = (text: string) => {
    const parts = text.split(/(\[[^\]]*\])/)
    return <For each={parts}>{(part) => part.startsWith("[") && part.endsWith("]") ? <mark>{part.slice(1, -1)}</mark> : <>{part}</>}</For>
  }
  // The hits hang over the top of the transcript and stay open after a pick,
  // so the pane learns their height while they show, and a landing centers
  // its row in the part of the transcript that they leave visible.
  const coverTranscript = (hitList: HTMLElement): void => {
    scrollEdges(hitList)
    onMount(() => {
      onCleanup(publishPaneHeight(hitList, "--fw-find-hits-height"))
    })
  }
  const sessionTitle = (hit: TranscriptSearchHit): string =>
    hit.sessionTitle ?? summaryOf(client.state(), hit.sessionId)?.title ?? hit.sessionId

  return (
    <div class="find" role="search" aria-label={KERNEL_COMMAND_NAMES.find} onKeyDown={onKeyDown}>
      <div class="find-bar">
        <Icon path={ICONS.search} size={13} />
        <input
          ref={(el) => { input = el; queueMicrotask(() => el.focus()) }}
          type="search"
          placeholder={KERNEL_COMMAND_NAMES.find}
          aria-label={KERNEL_COMMAND_NAMES.find}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <div class="find-scope" role="radiogroup" aria-label="Where to search">
          <button type="button" role="radio" aria-checked={scope() === "session"} classList={{ on: scope() === "session" }} onClick={() => { setScope("session"); input?.focus() }}>This chat</button>
          <button type="button" role="radio" aria-checked={scope() === "project"} classList={{ on: scope() === "project" }} onClick={() => { setScope("project"); input?.focus() }}>All chats</button>
        </div>
        <span class="find-count" aria-live="polite">
          <Show when={result()}>{(current) => <>{current().total === 0 ? "No matches" : `${active() + 1} of ${current().total}`}</>}</Show>
        </span>
        <button type="button" class="ghost" title="Close (Esc)" aria-label="Close find" onClick={props.onClose}><Icon path={ICONS.close} /></button>
      </div>
      <Show when={hits().length > 0}>
        <div class="find-hits scroll-edges" ref={coverTranscript} role="listbox" aria-label="Matches" aria-busy={busy()}>
          <ul class="find-list">
          <For each={hits()}>
            {(hit, index) => (
              <li role="option" aria-selected={active() === index()} classList={{ active: active() === index() }} onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()} onClick={() => { void open(index()) }}>
                <span class="find-hit-who">{roleLabel(hit.role)}</span>
                <span class="find-hit-text">{snippet(hit.snippet)}</span>
                <Show when={scope() === "project"}><span class="find-hit-session">{sessionTitle(hit)}</span></Show>
              </li>
            )}
          </For>
          <Show when={more()}>
            <li class="find-more"><button type="button" class="ghost-text" aria-busy={busy()} onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()} onClick={() => {
              // A search on its way already answers this tap; a second page
              // request for the same page would add its hits twice.
              if (!busy()) void run((result()?.page ?? 1) + 1)
            }}>{busy() ? "Loading…" : "More"}</button></li>
          </Show>
          </ul>
        </div>
      </Show>
    </div>
  )
}

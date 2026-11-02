import { createSignal, type Accessor, type JSX } from "solid-js"
import type { SessionCatalogRow } from "../../protocol/app-service-types.js"
import type { TranscriptSearchHit, TranscriptSearchRequest, TranscriptSearchResult } from "../../protocol/transcript-protocol-types.js"
import { createListModalKeys } from "../components/modal-list-keys.js"
import type { ModalContext } from "../components/modal-stack.js"
import type { SessionActivationResult } from "./session-activation.js"
import type { ShellServices } from "./shell-state.js"

/** Finding words in transcripts from the terminal: one modal with the query,
 *  the scope, and the ranked hits the runtime answers with. Typing edits the
 *  query, Tab switches between this chat and every chat, and Return opens the
 *  hit's session. The runtime does the search; this asks, shows, and opens. */

const DEBOUNCE_MS = 200

export type FindScope = "session" | "project"

/** The one query this modal makes, so a test hands it a plain answerer. */
interface TranscriptSearchClient {
  query(query: { readonly type: "transcriptSearch"; readonly request: TranscriptSearchRequest }): Promise<TranscriptSearchResult>
}

interface FindModalDeps {
  modal: Pick<ModalContext, "replace" | "clear">
  renderModal: () => JSX.Element
  appService: TranscriptSearchClient
  sessions: Accessor<readonly SessionCatalogRow[]>
  foregroundSessionId: Accessor<string | undefined>
  activateSession: (session: SessionCatalogRow) => Promise<SessionActivationResult>
  showToast: ShellServices["showToast"]
}

export interface FindModalHook {
  query: Accessor<string>
  scope: Accessor<FindScope>
  hits: Accessor<readonly TranscriptSearchHit[]>
  total: Accessor<number>
  busy: Accessor<boolean>
  cursor: Accessor<number>
  openFindModal: (initialQuery?: string) => void
  selectRow: (index: number) => void
  openRow: (index: number) => void
  /** The session a hit belongs to, as the catalog names it. */
  hitSession: (hit: TranscriptSearchHit) => SessionCatalogRow | undefined
}

export function useFindModal(deps: FindModalDeps): FindModalHook {
  const [query, setQuery] = createSignal("")
  const [scope, setScope] = createSignal<FindScope>("session")
  const [result, setResult] = createSignal<TranscriptSearchResult | undefined>()
  const [busy, setBusy] = createSignal(false)
  const [cursor, setCursor] = createSignal(0)
  const hits = () => result()?.hits ?? []
  const total = () => result()?.total ?? 0
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  async function run(): Promise<void> {
    const text = query().trim()
    const sessionId = deps.foregroundSessionId()
    const mine = ++generation
    if (text.length === 0) {
      setResult(undefined)
      setCursor(0)
      return
    }
    setBusy(true)
    try {
      const next = await deps.appService.query({ type: "transcriptSearch", request: { query: text, page: 1, ...(scope() === "session" && sessionId !== undefined ? { sessionId } : {}) } })
      if (mine !== generation) return
      setResult(next)
      setCursor(0)
    } catch (error) {
      if (mine === generation) deps.showToast({ message: `Search failed: ${error instanceof Error ? error.message : String(error)}`, variant: "error" })
    } finally {
      if (mine === generation) setBusy(false)
    }
  }
  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => { void run() }, DEBOUNCE_MS)
  }

  const hitSession = (hit: TranscriptSearchHit): SessionCatalogRow | undefined => deps.sessions().find((row) => row.id === hit.sessionId)

  function selectRow(index: number): void {
    if (hits()[index]) setCursor(index)
  }
  function openRow(index: number): void {
    const hit = hits()[index]
    const session = hit === undefined ? undefined : hitSession(hit)
    if (!hit || !session) return
    deps.modal.clear()
    void deps.activateSession(session).then((activated) => {
      if (!activated.ok && activated.error) deps.showToast({ message: `Open failed: ${activated.error}`, variant: "error" })
    })
  }

  const handleKey = createListModalKeys<TranscriptSearchHit>({
    rows: hits,
    cursor,
    setCursor,
    selectable: () => true,
    onSelect: openRow,
    onClose: deps.modal.clear,
    extra: (event) => {
      const name = event.name.toLowerCase()
      if (name === "tab") {
        event.preventDefault?.()
        setScope((current) => current === "session" ? "project" : "session")
        schedule()
        return true
      }
      if (name === "backspace") {
        event.preventDefault?.()
        setQuery((current) => current.slice(0, -1))
        schedule()
        return true
      }
      return false
    },
    // Whatever the shared keys did not take is typing into the query.
    textInput: (event) => {
      const text = event.sequence ?? event.raw
      if (!text || event.ctrl || event.meta || text.length !== 1 || text < " ") return
      setQuery((current) => current + text)
      schedule()
    },
  })

  function openFindModal(initialQuery = ""): void {
    setQuery(initialQuery)
    setResult(undefined)
    setCursor(0)
    deps.modal.replace(deps.renderModal, { onKey: handleKey })
    if (initialQuery.trim().length > 0) void run()
  }

  return { query, scope, hits, total, busy, cursor, openFindModal, selectRow, openRow, hitSession }
}

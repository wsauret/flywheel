import type { ChatInput, ChatInputLike } from "../../infra/chat-input.js"
import { batch, onCleanup } from "solid-js"
import { errorMessage } from "../../infra/error-message.js"
import { startupTrace } from "../../infra/startup-trace.js"
import type { FrontendMutation, MutationResult, SessionCatalogRow } from "../../protocol/app-service-types.js"
import type { ShellServices, ShellSignals } from "./shell-state.js"
import { UNBOUND_COMPOSER_DRAFT, type DraftCache } from "./create-draft-cache.js"
import type { TabState } from "./create-tabs.js"
import { mergeInputIntoDraft } from "./composer-draft-merge.js"

const FAILED_CHAT_DRAFT = "chat-open:failed"

/** How a session-creation request ended. */
export type SessionCreationSettlement =
  | { readonly kind: "foregrounded"; readonly sessionId: string }
  | { readonly kind: "stale"; readonly sessionId: string }
  | { readonly kind: "failed" }

interface SessionCreatorDeps {
  signals: Pick<ShellSignals, "foregroundId" | "setForegroundId" | "foregroundTarget" | "setForegroundTarget">
  appService: { dispatch(request: SessionCreationMutation): Promise<MutationResult<SessionCreationMutation>> }
  openSessionTab: (sessionId: string) => void
  openPendingTab: TabState["openPendingTab"]
  removePendingTab: TabState["removePendingTab"]
  hasPendingTab: TabState["hasPendingTab"]
  tabs: TabState["tabs"]
  draftCache: DraftCache
  adoptDraft: DraftCache["adopt"]
  seedSessionCatalogRow: (row: SessionCatalogRow) => void
  startKnownEmptyTranscript: (sessionId: string) => void
  retireTransientSession: (sessionId: string) => void
  showToast: ShellServices["showToast"]
}

type SessionCreationMutation = Extract<FrontendMutation, { readonly type: "chat.open" }>

export interface SessionCreator {
  startChat(initialMessage?: ChatInputLike): Promise<SessionCreationSettlement>
  /** Takes submitted initial messages whose delivery failed for explicit prompt recall. */
  recallFailedChat(): ChatInput | null
  /** Foregrounds a session the runtime created on the client's behalf, such as
   *  a fork a command answered with, through the same path a new chat takes. */
  focusSession(sessionId: string): void
}

/** Creates chat sessions and owns settlement for all requests that create a tab. */
export function createSessionCreator(deps: SessionCreatorDeps): SessionCreator {
  let disposed = false
  onCleanup(() => { disposed = true })

  function focusSession(sessionId: string): void {
    const previousSessionId = deps.signals.foregroundId()
    deps.openSessionTab(sessionId)
    deps.signals.setForegroundId(sessionId)
    if (previousSessionId && previousSessionId !== sessionId) deps.retireTransientSession(previousSessionId)
  }

  async function create(command: SessionCreationMutation, missingSessionMessage: string): Promise<SessionCreationSettlement> {
    const previous = deps.signals.foregroundTarget()
    const key = `pending:${crypto.randomUUID()}`
    batch(() => {
      deps.openPendingTab(key)
      deps.signals.setForegroundTarget({ kind: "pending", key })
    })
    let result: MutationResult<SessionCreationMutation>
    try {
      result = await deps.appService.dispatch(command)
    } catch (error) {
      result = { ok: false, error: errorMessage(error) }
    }
    if (disposed) return result.ok && result.sessionId ? { kind: "stale", sessionId: result.sessionId } : { kind: "failed" }
    const target = deps.signals.foregroundTarget()
    const ownsFocus = target?.kind === "pending" && target.key === key
    const stillOpen = deps.hasPendingTab(key)

    if (!result.ok || !result.sessionId) {
      if (command.initialMessage !== undefined) {
        mergeInputIntoDraft(deps.draftCache, FAILED_CHAT_DRAFT, command.initialMessage)
        deps.adoptDraft(key, UNBOUND_COMPOSER_DRAFT)
      }
      const list = deps.tabs()
      const index = list.findIndex((tab) => tab.kind === "pending" && tab.id === key)
      const prior = list.find((tab) => previous?.kind === tab.kind && tab.id === (previous.kind === "session" ? previous.sessionId : previous.key))
      const fallback = command.initialMessage === undefined ? prior ?? list[index + 1] ?? list[index - 1] : undefined
      batch(() => {
        deps.removePendingTab(key)
        if (ownsFocus) deps.signals.setForegroundTarget(fallback ? fallback.kind === "pending" ? { kind: "pending", key: fallback.id } : { kind: "session", sessionId: fallback.id } : undefined)
      })
      deps.draftCache.clear(key)
      const message = result.ok ? missingSessionMessage : result.error
      deps.showToast({ message: command.initialMessage === undefined ? message : `${message}. Press Up in an empty prompt to restore your message.`, variant: "error" })
      return { kind: "failed" }
    }

    const sessionId = result.sessionId
    const catalogRow = result.sessionCatalogRow
    batch(() => {
      if (catalogRow) deps.seedSessionCatalogRow(catalogRow)
      deps.removePendingTab(key)
      if (!stillOpen) return
      deps.startKnownEmptyTranscript(sessionId)
      deps.adoptDraft(key, sessionId)
      deps.openSessionTab(sessionId)
      if (ownsFocus) deps.signals.setForegroundId(sessionId)
    })
    // Composer's focus effect saves the old buffer before loading the adopted
    // draft. Clear its retired key after that synchronous effect has flushed.
    deps.draftCache.clear(key)
    if (stillOpen && ownsFocus && previous?.kind === "session" && previous.sessionId !== sessionId) deps.retireTransientSession(previous.sessionId)
    return { kind: stillOpen && ownsFocus ? "foregrounded" : "stale", sessionId }
  }

  /** Opens a chat, with its first message when there is one: a message sent
   *  while no chat tab is open. That message rides `chat.open` itself, so it
   *  is not sent again by itself when the connection ends first, as a
   *  waiting message is (PI-INTERACTION-024, PI-INTERACTION-124): a second `chat.open` would
   *  start a second chat. It fails, and the person recalls it for editing.
   *  The runtime may have opened the chat and taken the message before the
   *  answer was lost, so a resubmission can leave that chat beside a new
   *  one. ctrl+n calls this with no message, so the chat exists before the
   *  person types, and its first message goes through `session.send` and
   *  the outbox like any other. */
  async function startChat(initialMessage?: ChatInputLike): Promise<SessionCreationSettlement> {
    startupTrace("chat.open dispatch start")
    const settlement = await create({
      type: "chat.open",
      ...(initialMessage !== undefined ? { initialMessage } : {}),
    }, "Chat failed to start")
    startupTrace("chat.open dispatch done")
    if (settlement.kind === "foregrounded") startupTrace("chat foreground set")
    return settlement
  }

  function recallFailedChat(): ChatInput | null {
    if (!deps.draftCache.hasDraft(FAILED_CHAT_DRAFT)) return null
    const draft = deps.draftCache.get(FAILED_CHAT_DRAFT)
    deps.draftCache.clear(FAILED_CHAT_DRAFT)
    return { text: draft.text, ...(draft.attachments.length ? { attachments: draft.attachments } : {}) }
  }

  return { startChat, focusSession, recallFailedChat }
}

import type { AttachedRuntimeClient, SessionRow, Unsubscribe } from "../../runtime/app-service-types.js"
import type { StoppedChat, UnreadChatsView } from "../../session/unread-protocol-types.js"

/** One desktop notice: what an operating-system notification shows. */
export interface DesktopNotice {
  /** The session the notice is about, and what a click on the notice opens. */
  readonly sessionId: string
  /** What the notice pages for, one question or one stop, so a client that
   *  shows one notice for each can tell them apart. */
  readonly key: string
  readonly title: string
  readonly body: string
}

/** The longest chat title a stop page shows. A terminal notice keeps 200
 *  characters of its body, so a longer title would cut away the outcome. */
const STOP_TITLE_LIMIT = 120

/** The words of a page for a chat that stopped for the person: one line that
 *  names the chat and says that it finished, or that it stopped on an error.
 *  Every client pages with these words; a long title is shortened so that
 *  the outcome always shows. */
export function stopNoticeLine(stopped: Pick<StoppedChat, "ending">, title: string | undefined): string {
  const what = stopped.ending.kind === "completed" ? "finished" : "stopped on an error"
  const chat = (title || "A chat").replace(/\s+/g, " ").trim()
  return `${chat.length > STOP_TITLE_LIMIT ? `${chat.slice(0, STOP_TITLE_LIMIT - 1)}…` : chat} ${what}`
}

/** What a pager decided for one page: `shown`, or `suppressed` when the
 *  question was answered or the stop read before the page could show. */
export interface DesktopPageDecision {
  readonly decision: "shown" | "suppressed"
  readonly sessionId: string
  readonly kind: "question" | "stop"
}

/** The terminal and the browser page the person when a session, a chat or
 *  any agent, starts to wait on the person's answer, and when a chat stops
 *  for the person unread (PI-INTERACTION-052). Both clients page for the
 *  same questions and stops with the same words.
 *
 *  A question page is a live edge, never view recovery: a `question.updated`
 *  patch with a question id the session did not wait on pages once, and a
 *  `question.removed` patch or a new question cancels a page whose title is
 *  still being read. No read of a session's question reaches the pages, so
 *  the questions that wait when a client attaches, reconnects, or turns
 *  paging on are a baseline that pages no one. The pages compare question
 *  ids, never the runtime's clock with the client's.
 *
 *  A stop page is a live edge too: each stop that a patch of the project's
 *  set of stopped unread chats announces in `newStops` (ARCH-PROTOCOL-072)
 *  pages once, also when a read of the set covers the patch. The set
 *  announces only a chat that just stopped with no connection at it, so a
 *  read, a mark unread, and a stop recorded again for the same answer page
 *  no one. A later view that no longer lists the stop cancels a page whose
 *  title is still being read.
 *
 *  A notice is named by the title of the row the client holds for the
 *  session. A client holds no row for a workflow agent or a subagent it does
 *  not show, so the notice then reads the session's row once.
 *
 *  Returns the call that stops paging. A notice still reading its session's
 *  title then shows nothing. */
export function createDesktopPages(options: {
  readonly client: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">
  /** The row the client holds for the session, or undefined when it holds none. */
  readonly heldRow: (sessionId: string) => Pick<SessionRow, "title"> | undefined
  readonly show: (notice: DesktopNotice) => void
  /** Hears each decision, for a client that records them. */
  readonly decided?: (decision: DesktopPageDecision) => void
}): Unsubscribe {
  /** The question each session waits on, as the live patches told it. */
  const open = new Map<string, string>()
  /** The stop each chat's page is for while its title is read. */
  const pendingStops = new Map<string, string>()
  let disposed = false

  /** Shows the notice that `notice` builds from the session's title: at once
   *  from the held row, or after one read of the session while `current`
   *  still holds. A row that cannot be read leaves the page no less needed. */
  async function page(sessionId: string, kind: DesktopPageDecision["kind"], current: () => boolean, notice: (title: string | undefined) => DesktopNotice): Promise<void> {
    const show = (title: string | undefined): void => {
      options.show(notice(title))
      options.decided?.({ decision: "shown", sessionId, kind })
    }
    const held = options.heldRow(sessionId)
    if (held !== undefined) {
      show(held.title)
      return
    }
    let title: string | undefined
    try {
      title = (await options.client.query({ type: "sessionDetail", sessionId })).view?.row.title
    } catch {
      // The page shows without the title.
    }
    if (disposed) return
    if (current()) show(title)
    else options.decided?.({ decision: "suppressed", sessionId, kind })
  }

  function pageQuestion(sessionId: string, questionId: string): void {
    // The question was answered, or another replaced it, while the row was read.
    void page(sessionId, "question", () => open.get(sessionId) === questionId, (title) => ({
      sessionId, key: `question:${questionId}`, title: "Flywheel has a question", body: title || "A session waits for your answer",
    }))
  }

  function pageStop(chat: StoppedChat): void {
    const { sessionId, stopKey } = chat
    pendingStops.set(sessionId, stopKey)
    // The person read the chat, or a new turn started, while the row was read.
    void page(sessionId, "stop", () => pendingStops.get(sessionId) === stopKey, (title) => ({
      sessionId, key: `stop:${sessionId}:${stopKey}`, title: "Flywheel", body: stopNoticeLine(chat, title),
    })).finally(() => { if (pendingStops.get(sessionId) === stopKey) pendingStops.delete(sessionId) })
  }

  /** Drops each page still reading its title whose stop `view` no longer lists. */
  function prune(view: UnreadChatsView): void {
    for (const [sessionId, stopKey] of pendingStops) {
      if (!view.stopped.some((chat) => chat.sessionId === sessionId && chat.stopKey === stopKey)) pendingStops.delete(sessionId)
    }
  }

  const unsubscribe = options.client.subscribe((event) => {
    if (disposed || event.type !== "patch") return
    const { payload } = event.patch
    if (payload.kind === "unreadChats.changed") {
      prune(payload)
      for (const chat of payload.newStops) pageStop(chat)
      return
    }
    if (event.patch.cursor.scope !== "session") return
    const { sessionId } = event.patch.cursor
    if (payload.kind === "question.removed") {
      open.delete(sessionId)
      return
    }
    if (payload.kind !== "question.updated" || open.get(sessionId) === payload.question.toolUseId) return
    open.set(sessionId, payload.question.toolUseId)
    pageQuestion(sessionId, payload.question.toolUseId)
  })

  // The set publishes nothing until something reads it, and a restarted
  // runtime starts it again, so each lane reads it once. The answer is not
  // needed, since a page comes only from a live patch, so a failed read
  // changes nothing that the pages hold.
  const stopLanes = options.client.onLane(() => { options.client.query({ type: "unreadChatsSnapshot" }).catch(() => undefined) })

  return () => {
    disposed = true
    unsubscribe()
    stopLanes()
  }
}

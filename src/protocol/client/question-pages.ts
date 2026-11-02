import type { RuntimeClient, SessionRow, Unsubscribe } from "../app-service-types.js"

/** One desktop notice: what an operating-system notification shows. */
export interface DesktopNotice {
  /** The session that asks, and what a click on the notice opens. */
  readonly sessionId: string
  /** The question's own id, so a client that shows one notice for each
   *  question can tell them apart. */
  readonly questionId: string
  readonly title: string
  readonly body: string
}

/** The terminal and the browser page the person only when a session, a chat
 *  or any agent, starts to wait on the person's answer (PI-INTERACTION-052).
 *  The pages hear the live question patches the runtime broadcasts for every
 *  session, as the phone push does, so both clients page for the same
 *  questions with the same words.
 *
 *  A page is a live edge, never view recovery: a `question.updated` patch
 *  with a question id the session did not wait on pages once, and a
 *  `question.removed` patch or a new question cancels a page whose title is
 *  still being read. No read of a session's question reaches the pages, so
 *  the questions that wait when a client attaches, reconnects, or turns
 *  paging on are a baseline that pages no one. The pages compare question
 *  ids, never the runtime's clock with the client's.
 *
 *  A notice is named by the title of the row the client holds for the
 *  session. A client holds no row for a workflow agent or a subagent it does
 *  not show, so the notice then reads the session's row once.
 *
 *  Returns the call that stops paging. A notice still reading its session's
 *  title then shows nothing. */
export function createQuestionPages(options: {
  readonly client: Pick<RuntimeClient, "query" | "subscribe">
  /** The row the client holds for the session, or undefined when it holds none. */
  readonly heldRow: (sessionId: string) => Pick<SessionRow, "title"> | undefined
  readonly show: (notice: DesktopNotice) => void
}): Unsubscribe {
  /** The question each session waits on, as the live patches told it. */
  const open = new Map<string, string>()
  let disposed = false

  function show(sessionId: string, questionId: string, title: string | undefined): void {
    options.show({ sessionId, questionId, title: "Flywheel has a question", body: title || "A session waits for your answer" })
  }

  async function page(sessionId: string, questionId: string): Promise<void> {
    const held = options.heldRow(sessionId)
    if (held !== undefined) {
      show(sessionId, questionId, held.title)
      return
    }
    let title: string | undefined
    try {
      title = (await options.client.query({ type: "sessionDetail", sessionId })).view?.row.title
    } catch {
      // A row that cannot be read leaves the question no less blocking.
    }
    // The question was answered, or another replaced it, while the row was read.
    if (disposed || open.get(sessionId) !== questionId) return
    show(sessionId, questionId, title)
  }

  const unsubscribe = options.client.subscribe((event) => {
    if (disposed || event.type !== "patch" || event.patch.cursor.scope !== "session") return
    const { sessionId } = event.patch.cursor
    const { payload } = event.patch
    if (payload.kind === "question.removed") {
      open.delete(sessionId)
      return
    }
    if (payload.kind !== "question.updated" || open.get(sessionId) === payload.question.toolUseId) return
    open.set(sessionId, payload.question.toolUseId)
    void page(sessionId, payload.question.toolUseId)
  })
  return () => {
    disposed = true
    unsubscribe()
  }
}

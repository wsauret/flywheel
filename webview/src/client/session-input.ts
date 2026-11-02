import type { FrontendMutation, SessionRow } from "../../../src/protocol/app-service-types.js"
import { createChatSubmissions, type ChatSubmissionResult, type ChatSubmissions, type LocalChatSubmission, type UnsentChatSubmission } from "../../../src/protocol/client/chat-submissions.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { lostWithLane } from "../../../src/protocol/client/connection-failures.js"
import { dispatchInterrupt, resumeMutation, sessionControls, stopMutation } from "../../../src/protocol/client/session-controls.js"
import { NO_PROVIDER_READY, settledProviderSetup, type ProviderSetup } from "../../../src/protocol/client/provider-setup.js"
import { describeFailure } from "./failure-message.js"
import type { RuntimeSession } from "./session.js"
import type { HoldOutcome } from "../../../src/protocol/client/held-session-details.js"

/** Dispatches input and controls against current admission, not catalog membership.
 * Refusals reject so the existing client action boundary can report them.
 *
 * A message sent into an open session is a local entry from the call until
 * the runtime shows it back. `submissions` owns those entries; the session
 * retires them as its transcript adopts the runtime's user messages. */
type ChatInput = LocalChatSubmission["input"]

/** The key of the entries sent with no chat open. They are the first messages
 *  of the new chat they create, and move to it once the runtime creates it.
 *  No session id is empty, so the key never names a session. */
export const NEW_CHAT_ENTRIES = ""

const NO_PROVIDER_REFUSAL = `${NO_PROVIDER_READY}. Connect one, then send the message again`

/** A refused child send leaves its draft in place and needs only the runtime's warning. */
export class DraftKeptRefusal extends Error {}

export function createSessionInput(options: {
  readonly connection: RuntimeConnection
  readonly selected: () => string | undefined
  readonly row: (id: string) => SessionRow | undefined
  readonly refreshStatus: (id: string) => void
  readonly hold: (id: string) => Promise<HoldOutcome>
  /** Moves the pane to the new chat and answers its id once the runtime
   *  creates it, joining a creation that already runs. */
  readonly newChat: () => Promise<string>
  /** True for the chat the runtime just created for the new chat. It is a
   *  chat by construction, so a message to it waits for no detail. */
  readonly created: (id: string) => boolean
  /** The session's block count this page knows now, which places a message
   *  the runtime accepted in its transcript. */
  readonly position: (id: string) => number | undefined
  /** Whether a model provider can serve a send, by the one shared rule. */
  readonly providerSetup: () => ProviderSetup
  /** Settles once the first auth read answers or fails. */
  readonly providerSetupKnown: () => Promise<void>
  /** The messages the page this one replaced sent and the runtime had not
   *  answered. They show queued and go out on the first lane. */
  readonly unsent?: readonly UnsentChatSubmission[]
}): Pick<RuntimeSession, "send" | "interrupt" | "resume" | "stop" | "recallLocal" | "recallQueued" | "answer" | "cancelQuestion" | "compact" | "terminateBackground" | "detachBash"> & { readonly submissions: ChatSubmissions } {
  const { connection } = options
  /** Per destination, the handoff of its newest message to the connection.
   *  The next message waits for it, so the messages to one session leave in
   *  the order they were sent, even when the first waits for the session's
   *  detail and a later one finds the row at once. */
  const handoffs = new Map<string, Promise<void>>()
  /** Delivers one input to `destination`, which the runtime routes by its
   *  session's kind. A refusal fails the local entry, which keeps the words
   *  on screen for the person to recall. */
  const deliver = async (destination: string, input: ChatInput): Promise<ChatSubmissionResult> => {
    const ahead = handoffs.get(destination)
    let handed = () => {}
    const handoff = new Promise<void>((resolve) => { handed = resolve })
    handoffs.set(destination, handoff)
    try {
      // With no model provider set up, a send would open a chat whose turn
      // fails at once. The setup screen replaces the pane instead, and the
      // words wait in the failed entry until a provider is connected. A known
      // setup is decided in this call, so the pane moves at once.
      const known = options.providerSetup()
      const setup = known === "loading" ? await settledProviderSetup(options.providerSetup, options.providerSetupKnown) : known
      if (setup === "none") return { ok: false, error: NO_PROVIDER_REFUSAL }
      // A message with no chat open joins the creation before it waits for
      // the message ahead: once that creation ends no creation runs, and a
      // later join would start a second chat.
      const created = destination === NEW_CHAT_ENTRIES ? options.newChat() : undefined
      created?.catch(() => {})
      if (ahead !== undefined) await ahead
      const route = await routeOf(destination, created)
      if ("error" in route) return { ok: false, error: route.error }
      const sent = connection.dispatch({ type: "session.send", sessionId: route.sessionId, input })
      handed()
      const result = await sent
      if (result.ok) options.refreshStatus(route.sessionId)
      return result
    } finally {
      handed()
      if (handoffs.get(destination) === handoff) handoffs.delete(destination)
    }
  }
  /** The session a message to `destination` goes to, or why it cannot go.
   *  The new chat is a chat by construction, so its messages go to the chat
   *  the runtime creates with no read of its detail. Any other session's row
   *  says whether it takes a message now. */
  const routeOf = async (destination: string, created: Promise<string> | undefined): Promise<{ readonly sessionId: string } | { readonly error: string }> => {
    if (created !== undefined) {
      try {
        return { sessionId: await created }
      } catch (cause) {
        // A creation lost with its connection never ends here: it names its
        // chat and goes out again on the next lane, so the message waits for
        // it like any other. Only the runtime's refusal fails the message,
        // which stays for the person to edit and send.
        return { error: `Flywheel could not start a new chat: ${describeFailure(cause)}` }
      }
    }
    if (options.created(destination)) return { sessionId: destination }
    const row = options.row(destination) ?? await heldRow(destination)
    if (typeof row === "string") return { error: row }
    if (!sessionControls(row).message) return { error: "This session is read-only" }
    return { sessionId: destination }
  }
  /** The row of a destination the pane moved to before its detail arrived,
   *  once the detail answers, or why it cannot be had. The row decides
   *  whether the session takes a message, so the message waits for it. */
  const heldRow = async (sessionId: string): Promise<SessionRow | string> => {
    const outcome = await options.hold(sessionId)
    // A hold released while it read belongs to a pane that moved on. The
    // message still goes where it was sent, so it reads the row once with a
    // plain detail read, which the runtime holds nothing for.
    if (outcome.kind === "released") return readRow(sessionId)
    if (outcome.kind === "missing") return SESSION_MISSING
    if (outcome.kind === "failed") return unreadable(outcome.cause)
    return options.row(sessionId) ?? "Session detail is unavailable"
  }
  /** A read lost with its lane is not a reason to refuse the message: the
   *  rejection reaches the submissions owner, and the message waits for the
   *  next lane like a send lost with its lane. */
  const readRow = async (sessionId: string): Promise<SessionRow | string> => {
    try {
      return (await connection.query({ type: "sessionDetail", sessionId })).view?.row ?? SESSION_MISSING
    } catch (cause) {
      if (lostWithLane(cause)) throw cause
      return unreadable(cause)
    }
  }
  /** Dispatches the mutation for the open session; with none open there is
   *  nothing to act on. A refusal rejects with the runtime's words, so a tap
   *  that does nothing says why. */
  const onOpenSession = async (mutation: (sessionId: string) => OpenSessionMutation): Promise<void> => {
    const sessionId = options.selected()
    if (sessionId === undefined) return
    const result = await connection.dispatch(mutation(sessionId))
    if (!result.ok) throw new Error(result.error)
  }
  /** A waiting message's next send: straight to the runtime, which routes
   *  it by the session's kind, with none of the admission above. */
  const resend = async (sessionId: string, input: ChatInput): Promise<ChatSubmissionResult> => {
    const result = await connection.dispatch({ type: "session.send", sessionId, input })
    if (result.ok) options.refreshStatus(sessionId)
    return result
  }
  const submissions = createChatSubmissions({ dispatch: deliver, resend, lanes: connection, position: options.position, ...(options.unsent === undefined ? {} : { unsent: options.unsent }) })
  /** A refusal rejects for the action boundary to report. A message that
   *  waits for the connection is no failure, so it reports nothing. */
  const submit = async (sessionId: string, input: ChatInput): Promise<void> => {
    const outcome = await submissions.send(sessionId, input)
    if (outcome.kind === "draft_kept") throw new DraftKeptRefusal(outcome.error)
    if (outcome.kind === "failed") throw new Error(outcome.error)
  }
  /** The open session's row, or a refusal that says why the control cannot
   *  act: a tap that does nothing must say so. A child's row is unknown until
   *  its detail arrives. */
  const controlledRow = (verb: string): SessionRow => {
    const id = options.selected()
    if (id === undefined) throw new Error(`No session is open to ${verb}`)
    const row = options.row(id)
    if (!row) throw new Error(`The session's details have not loaded yet, so Flywheel cannot ${verb} it. Try again in a moment`)
    return row
  }
  const interruptRow = async (row: SessionRow, targets?: readonly string[]): Promise<void> => {
    const refusal = await dispatchInterrupt(connection, row, targets)
    options.refreshStatus(row.id)
    if (refusal) throw new Error(refusal.reason)
  }
  const resumeRow = async (row: SessionRow, targets?: readonly string[]): Promise<void> => {
    const result = await connection.dispatch(resumeMutation(row, targets))
    if (!result.ok) throw new Error(result.error)
    void options.hold(row.id)
  }
  return {
    submissions,
    async send(text, attachments) {
      const trimmed = text.trim()
      const files = attachments !== undefined && attachments.length > 0 ? attachments : undefined
      if (trimmed.length === 0 && files === undefined) return
      const input: ChatInput = files === undefined ? { text: trimmed } : { text: trimmed, attachments: files }
      // The entry shows in this call, before any wait. With no chat open it
      // is the first message of a new chat, which the send moves the pane to.
      return submit(options.selected() ?? NEW_CHAT_ENTRIES, input)
    },
    recallLocal(entryId) {
      return submissions.recallLocal(options.selected() ?? NEW_CHAT_ENTRIES, entryId) ?? undefined
    },
    async recallQueued() {
      const sessionId = options.selected()
      if (sessionId === undefined) return undefined
      const queued = await submissions.recallQueued(sessionId, () => connection.query({ type: "recallQueuedMessage", sessionId }))
      // The composer holds only text for a queued message, so the one field
      // it reads is checked rather than asserted.
      if (queued === null || typeof queued !== "object") return undefined
      return queued.text.length > 0 ? queued.text : undefined
    },
    // Each control is async, so a refusal reaches its caller as a rejection.
    async interrupt(targets) { await interruptRow(controlledRow("interrupt"), targets) },
    async resume(targets) { await resumeRow(controlledRow("resume"), targets) },
    async stop(target) {
      const mutation = stopMutation(options.row(target))
      if (!mutation) throw new Error("This session cannot be stopped")
      const result = await connection.dispatch(mutation)
      options.refreshStatus(target)
      if (!result.ok) throw new Error(result.error)
    },
    answer: (toolUseId, answers) => onOpenSession((sessionId) => ({ type: "question.answer", sessionId, toolUseId, answers })),
    cancelQuestion: (toolUseId) => onOpenSession((sessionId) => ({ type: "question.cancel", sessionId, toolUseId })),
    compact: () => onOpenSession((sessionId) => ({ type: "chat.compact", sessionId })),
    terminateBackground: (toolUseId) => onOpenSession((sessionId) => ({ type: "background.terminate", sessionId, toolUseId })),
    detachBash: (toolUseId) => onOpenSession((sessionId) => ({ type: "bash.detach", sessionId, toolUseId })),
  }
}

/** The controls that act on the open session and answer only accepted or refused. */
type OpenSessionMutation = Extract<FrontendMutation, { type: "question.answer" | "question.cancel" | "chat.compact" | "background.terminate" | "bash.detach" }>

const SESSION_MISSING = "Flywheel could not find this session"
const unreadable = (cause: unknown): string => `Flywheel could not read this session: ${describeFailure(cause)}`

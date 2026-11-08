import { createSignal } from "solid-js"
import type { ChatInput, ChatInputLike } from "../../infra/chat-input.js"
import { DebugLog } from "../../infra/debug-log.js"
import { errorMessage } from "../../infra/error-message.js"
import type { AttachedRuntimeClient } from "../../protocol/app-service-types.js"
import { createChatSubmissions, type ChatSubmissionContext, type ChatSubmissionResult, type LocalChatSubmission, type LocalRecall, type UnsentChatSubmission } from "../../protocol/client/chat-submissions.js"
import { lostWithLane } from "../../protocol/client/connection-failures.js"

// A lost call's own text names the transport (`SocketCloseError: 1000`),
// which a person cannot act on.
const RECALL_LOST_WITH_LANE = "the connection to Flywheel dropped before it answered"

/** The terminal's binding of the shared submissions owner: Solid reactivity for
 *  the transcript, a toast for a refused send, and the
 *  `chat.submission.feedback` record in this terminal's debug log. A message
 *  lost with the connection shows no toast: it stays queued and goes out
 *  again when the connection returns. Up on such a message says why it
 *  cannot be edited. A queued recall never rejects: a refusal or a lost
 *  connection shows one warning and resolves null, the same as an empty
 *  recall, so neither composer's settle site handles a rejection. */
export function createTerminalChatSubmissions(deps: {
  dispatch: (sessionId: string, input: ChatInput) => Promise<ChatSubmissionResult>
  lanes: Pick<AttachedRuntimeClient, "onLane">
  report: (message: string, variant: "error" | "warning" | "info") => void
  /** The messages a predecessor terminal handed over unanswered. */
  unsent?: readonly UnsentChatSubmission[]
  now?: () => number
  position?: (sessionId: string) => number | undefined
  context?: () => ChatSubmissionContext
}) {
  const submissions = createChatSubmissions({
    dispatch: deps.dispatch,
    lanes: deps.lanes,
    ...(deps.unsent === undefined ? {} : { unsent: deps.unsent }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.position === undefined ? {} : { position: deps.position }),
    ...(deps.context === undefined ? {} : { context: deps.context }),
    feedback: ({ sessionId, payload }) => DebugLog.record({ type: "chat.submission.feedback", sessionId, notable: true, payload }),
  })
  // The owner replaces a session's array on every change, so one tick is
  // enough for each reader to see its own session's current array.
  const [changed, setChanged] = createSignal(undefined, { equals: false })
  submissions.subscribe(() => setChanged())
  return {
    ...submissions,
    /** A child composer keeps its draft until this receipt settles. Its viewer reports refusals. */
    sendWithReceipt: submissions.send,
    async send(sessionId: string, input: ChatInput): Promise<void> {
      const outcome = await submissions.send(sessionId, input)
      if (outcome.kind === "failed") deps.report(outcome.error, "error")
    },
    recallLocal(sessionId: string): LocalRecall | null {
      const local = submissions.recallLocal(sessionId)
      if (local?.kind === "waiting") deps.report(local.notice, "info")
      return local
    },
    async recallQueued(sessionId: string, query: () => Promise<ChatInputLike | null>): Promise<ChatInputLike | null> {
      try {
        return await submissions.recallQueued(sessionId, query)
      } catch (cause) {
        deps.report(`Flywheel could not recall the queued message: ${lostWithLane(cause) ? RECALL_LOST_WITH_LANE : errorMessage(cause)}`, "warning")
        return null
      }
    },
    pending(sessionId: string): readonly LocalChatSubmission[] {
      changed()
      return submissions.pending(sessionId)
    },
  }
}

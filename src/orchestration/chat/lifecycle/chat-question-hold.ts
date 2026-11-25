import type { OutputSession } from "../../session-store/output-session.js"
import { showMessageRow } from "../message-row.js"
import type { ConversationTreeWriterController } from "../tree-writer.js"
import type { ChatTurnMailbox } from "../turn-mailbox.js"

/** The parts of a chat runner that the input held behind a waiting
 *  question meets. */
export interface ChatQuestionHoldPorts {
  readonly treeWriter: Pick<ConversationTreeWriterController, "awaitsAnswer" | "readHeldMessages" | "releaseHeldInput">
  readonly mailbox: Pick<ChatTurnMailbox, "adoptHeld" | "takeHeld">
  readonly session: Pick<OutputSession, "pushDivider" | "pushUserMessage" | "flush">
  ended(): boolean
  /** `ChatSessionDeps.refreshDisplay`. */
  refreshDisplay(): Promise<void>
}

/** The input that waits in its durable cell behind a question for the
 *  person (ARCH-SESSIONS-050): the runner takes it into its mailbox at
 *  attach, and the turn that continues the settled question lands it after
 *  the question's result. */
export function createChatQuestionHold(ports: ChatQuestionHoldPorts) {
  const { treeWriter, mailbox, session } = ports

  return {
    /** `ChatPorts.adoptHeldInput`: while a question waits, takes the
     *  messages held behind it into the mailbox, in the order they arrived,
     *  and shows each as a queued message is shown, so a recall can take one
     *  back. The attach runs it on a display that holds the stored
     *  transcript only, so no held message has a row yet. Reading the
     *  question opens the writer, so every later gate of the runner reads it
     *  in its own tick. */
    async adopt(): Promise<void> {
      if (!await treeWriter.awaitsAnswer()) return
      const held = await treeWriter.readHeldMessages()
      if (ports.ended()) return
      const joined = mailbox.adoptHeld(held)
      for (const { key, input } of joined) showMessageRow(session, input, { queued: true, entryId: key })
      if (joined.length > 0) session.flush()
    },

    /** Lands the held cells in the order they arrived, before the request of
     *  the turn that continues the settled question. The queue gives up its
     *  copies first, so the writer commits every cell but one that an open
     *  recall takes back. The writer lands them outside the turn's events,
     *  and the turn has shown nothing yet, so the display reads the
     *  conversation again: each message, notice, and system entry shows as
     *  the transcript holds it, in that order. */
    async release(): Promise<void> {
      await treeWriter.releaseHeldInput(mailbox.takeHeld().notificationKeys)
      await ports.refreshDisplay()
    },
  }
}

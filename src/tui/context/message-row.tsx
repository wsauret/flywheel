/** @jsxImportSource @opentui/solid */
import { createContext, untrack, useContext, type JSX } from "solid-js"
import type { MessageSender } from "../../infra/output-blocks.js"

/** How a message row from another session presents instead of its disclosure: one line that opens `linkUri`, and
 *  what shows under that line, such as a form that answers the message. The row mounts `below` once and keeps it while
 *  the presentation names one, and shows its line only once the part below calls `ready`, so that the line never shows
 *  without the part: the part calls it in the update that first gives it rows. */
interface MessageRowPresentation {
  readonly name: string
  readonly detail: string
  readonly linkUri: string
  readonly below?: (ready: () => void) => JSX.Element
}

/** A message row from another session: its entry id, `msg:<sender>:<call>` (see `blockEntryKeys`), and its sender. */
export type MessageRowReader = (message: { readonly id: string; readonly from: MessageSender }) => MessageRowPresentation | undefined

const MessageRowContext = createContext<MessageRowReader>(() => undefined)

/** The presentation that the transcript gives a message row from another session, or undefined for the ordinary row. */
export function useMessageRow(): MessageRowReader {
  return useContext(MessageRowContext)
}

/** Gives the message rows of one transcript below it the presentation that `present` answers. */
export function MessageRowProvider(props: { readonly present: MessageRowReader; readonly children: JSX.Element }): JSX.Element {
  // A provider's presentation is fixed for its life, as a context value is.
  return <MessageRowContext.Provider value={untrack(() => props.present)}>{props.children}</MessageRowContext.Provider>
}

/** @jsxImportSource @opentui/solid */
import { createContext, untrack, useContext, type JSX } from "solid-js"
import type { MessageSender } from "../../infra/output-blocks.js"

/** How a message row from another session presents instead of its disclosure: one line that opens `linkUri`. */
interface MessageRowPresentation {
  readonly name: string
  readonly detail: string
  readonly linkUri: string
}

/** A message row from another session: its entry id, `msg:<sender>:<call>` (see `blockEntryKeys`), and its sender. */
type MessageRowReader = (message: { readonly id: string; readonly from: MessageSender }) => MessageRowPresentation | undefined

const MessageRowContext = createContext<MessageRowReader>(() => undefined)

/** The presentation that a module gives a message row from another session, or undefined for the ordinary row. */
export function useMessageRow(): MessageRowReader {
  return useContext(MessageRowContext)
}

/** Gives the message rows below it the presentation that `present` answers; a row it answers nothing for keeps the
 *  presentation of the providers above. */
export function MessageRowProvider(props: { readonly present: MessageRowReader; readonly children: JSX.Element }): JSX.Element {
  const outer = useMessageRow()
  // A provider's presentation is fixed for its life, as a context value is.
  const present = untrack(() => props.present)
  return <MessageRowContext.Provider value={(message) => present(message) ?? outer(message)}>{props.children}</MessageRowContext.Provider>
}

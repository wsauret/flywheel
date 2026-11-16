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

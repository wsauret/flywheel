import { chatInputImages, chatInputText, normalizeChatInput, type ChatInputLike } from "../../../infra/substrate/events/chat-input.js"
import { messageSenderOf } from "../../../infra/substrate/events/output-blocks.js"
import type { OutputSession } from "../../session-store/output-session.js"
import { invocationBoundaryId } from "../../session/conversation/transcript/invocation-boundary.js"

/** Shows an accepted message in the chat's display, as the transcript shows
 *  it once it is committed: a person's message, or a message from another
 *  session with its sender. An inline step or skill invocation shows as its
 *  divider and the raw arguments the person typed, because the expanded
 *  prompt body is model-facing only. The row carries the client's submission
 *  ids, which are the client's proof of delivery, so a caller shows the
 *  message only once it is durable. A queued row also names its held cell, by
 *  which a recall withdraws exactly that row. The caller flushes. */
export function showMessageRow(
  session: Pick<OutputSession, "pushDivider" | "pushUserMessage">,
  input: ChatInputLike,
  row: { readonly queued: boolean; readonly entryId: string | undefined },
): void {
  const { invocation, submissionIds, dispatchIds, producer } = normalizeChatInput(input)
  const from = messageSenderOf(producer)
  const state = {
    entryId: row.entryId, queued: row.queued, injected: false,
    ...(submissionIds?.length ? { submissionIds } : {}),
    ...(dispatchIds?.length ? { dispatchIds } : {}),
    ...(from ? { from } : {}),
  }
  if (invocation) {
    // The id that the stored transcript gives the divider, so that a display
    // refresh keeps the divider of a queued message with its row.
    session.pushDivider(invocation.label, Date.now(), row.entryId === undefined ? undefined : invocationBoundaryId(row.entryId))
    if (invocation.args) session.pushUserMessage(invocation.args, Date.now(), state)
    return
  }
  const images = chatInputImages(input)
  session.pushUserMessage(chatInputText(input), Date.now(), { ...state, ...(images.length ? { images } : {}) })
}

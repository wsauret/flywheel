import type { ChatInput } from "../../infra/chat-input.js"
import type { AttachChildSessionProjection } from "../module-seams.js"

/** One unread human input taken out of its reader's queue, and the way back to its place. */
export interface QueuedInputWithdrawal { readonly input: ChatInput; restore(): void }

/** A reader's queue that gives up its latest unread human input. */
export interface HumanInputQueue { withdrawHuman(): QueuedInputWithdrawal | null }

/** The one recall of a reader's unread human input: the main chat's and a
 *  subagent viewer's. It withdraws the input from the queue, then its row,
 *  and resolves with the bare input only once its durable hold is retired,
 *  so the words never leave while the conversation still holds them as
 *  sent. Resolves null when nothing unread is queued, or when its row was
 *  already delivered. A failed retirement puts the row and the input back
 *  in their places and rejects with the store's error. */
export async function recallQueuedInput(input: {
  readonly queue: HumanInputQueue
  readonly retire: (keys: readonly string[]) => Promise<void>
  readonly projection?: Pick<Awaited<ReturnType<AttachChildSessionProjection>>, "withdrawQueuedMessage">
}): Promise<ChatInput | null> {
  const withdrawal = input.queue.withdrawHuman()
  if (!withdrawal) return null
  const keys = withdrawal.input.dispatchIds ?? []
  const restore = input.projection?.withdrawQueuedMessage?.(keys)
  if (input.projection?.withdrawQueuedMessage && !restore) {
    withdrawal.restore()
    return null
  }
  try {
    await input.retire(keys)
    const { dispatchIds: _retired, ...recalled } = withdrawal.input
    return recalled
  } catch (error) {
    withdrawal.restore()
    restore?.()
    throw error
  }
}

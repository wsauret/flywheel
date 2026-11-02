import type { ChatInput } from "../../infra/chat-input.js"
import type { AttachChildSessionProjection } from "../module-seams.js"
import type { WorkflowInjectionQueue } from "../workflow-host/injection-queue.js"

/** Withdraws unread human input from the queue, display, and durable hold.
 * A failed display removal or retirement restores the input before rejecting. */
export async function recallQueuedInput(input: {
  readonly queue: WorkflowInjectionQueue
  readonly retire: (keys: readonly string[]) => Promise<void>
  readonly projection?: Awaited<ReturnType<AttachChildSessionProjection>>
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

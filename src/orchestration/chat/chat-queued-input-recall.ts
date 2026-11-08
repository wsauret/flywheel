import type { ChatInput } from "../../infra/chat-input.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { OutputSession } from "../runner/output-session.js"
import { recallQueuedInput, type HumanInputQueue } from "../session/queued-input-recall.js"

const log = Log.create({ service: "chat" })

/** The chat's recall of the person's queued message, and the wait for it. */
export interface ChatQueuedInputRecall {
  /** `recallQueuedInput` over the chat's mailbox, its queued row, and its
   *  held cell: resolves with the input only once its hold is retired, null
   *  when nothing unread is queued or the chat has ended, and rejects with
   *  the store's error, which leaves the message queued. */
  recall(): Promise<ChatInput | null>
  /** Settles when the open recall settles; undefined while none is open.
   *  Until it settles, the mailbox lacks that input, which either leaves for
   *  the editor or returns to its place, so each decision whether queued
   *  input starts a turn waits for it. It never rejects. */
  readonly open: Promise<void> | undefined
  /** Whether the open recall withdraws the input that the dispatch id
   *  `key` names: its held cell is the recall's to retire or restore. */
  withdraws(key: string): boolean
}

export function createChatQueuedInputRecall(input: {
  readonly mailbox: HumanInputQueue
  readonly session: Pick<OutputSession, "withdrawQueued" | "flush">
  readonly retire: (keys: readonly string[]) => Promise<void>
  readonly ended: () => boolean
}): ChatQueuedInputRecall {
  const { session } = input
  // The session actor runs one recall at a time.
  let open: Promise<void> | undefined
  let withdrawn: readonly string[] = []
  return {
    get open() { return open },
    withdraws: (key) => open !== undefined && withdrawn.includes(key),
    recall() {
      if (input.ended()) return Promise.resolve(null)
      const recall = recallQueuedInput({
        queue: {
          withdrawHuman: () => {
            const withdrawal = input.mailbox.withdrawHuman()
            withdrawn = withdrawal?.input.dispatchIds ?? []
            return withdrawal
          },
        },
        retire: input.retire,
        projection: {
          withdrawQueuedMessage: (keys) => {
            const restore = session.withdrawQueued(keys)
            session.flush()
            return restore && (() => { restore(); session.flush() })
          },
        },
      })
      // The recall withdraws before its first await, so the mailbox lacks the
      // input only while this is set.
      open = recall.then(() => { open = undefined }, (error: unknown) => {
        open = undefined
        log.warn("queued input recall failed", { error: errorMessage(error) })
      })
      return recall
    },
  }
}

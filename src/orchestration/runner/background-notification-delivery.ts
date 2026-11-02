import type { ConversationTreeWriterController } from "../chat/tree-writer.js"
import type { WorkflowInjectionQueue } from "../workflow-host/injection-queue.js"
import type { HeldBackgroundNotification } from "../session/conversation/queued-background-notifications.js"

/** Holds a Chat completion before mailbox admission and acknowledges only its
 * keyed commit. A closing Chat keeps the hold without taking more input. */
export function createChatNotificationDelivery(options: {
  conversation: Pick<ConversationTreeWriterController, "holdBackgroundNotification" | "waitForBackgroundNotification">
  admitsInput: () => boolean
  submit: (notification: HeldBackgroundNotification) => Promise<boolean>
}) {
  let admission = Promise.resolve()
  return {
    enqueue(text: string, key?: string): Promise<void> {
      let held: HeldBackgroundNotification | undefined
      const admitted = admission.catch(() => {}).then(async () => {
        held = await options.conversation.holdBackgroundNotification(text, key)
        if (held && options.admitsInput() && !await options.submit(held)) throw new Error("Background notification was not admitted to Chat")
      })
      admission = admitted
      return admitted.then(async () => {
        if (held?.key !== undefined) await options.conversation.waitForBackgroundNotification(held.key)
      })
    },
    settle: () => admission,
  }
}

/** Holds produced input before mailbox admission. A notification that names
 *  a key is held under it: a reconciled child's completion is already held
 *  there, so holding it again writes the same cell, and a command's
 *  completion is held there on its way in. A key the conversation already
 *  committed reaches the queue no more, so a repeat of one completion commits
 *  once. A failed hold aborts the active runner immediately; settlement
 *  rethrows it after producers close. Later deliveries still run, so one
 *  rejected write cannot strand their output. */
export function createBackgroundNotificationDelivery(options: {
  conversation: Pick<ConversationTreeWriterController, "holdBackgroundNotification" | "waitForBackgroundNotification">
  queue: WorkflowInjectionQueue
  abort: () => void
}) {
  let tail = Promise.resolve()
  let failure: { cause: unknown } | undefined
  const pending = new Map<string, Promise<void>>()
  return {
    /** `runtimeNotice` is the registry's label (`RegistryOptions.enqueueNotification`); any other notice, such as a
     *  command's completion or returned messages, reaches the queue unlabeled. */
    enqueue(text: string, key?: string, runtimeNotice = false): Promise<void> {
      if (key !== undefined) {
        const delivery = pending.get(key)
        if (delivery) return delivery
      }
      let committed: Promise<void> = Promise.resolve()
      let refused: { cause: unknown } | undefined
      tail = tail.then(async () => {
        const held = await options.conversation.holdBackgroundNotification(text, key)
        if (held === undefined) return
        const admitted = runtimeNotice
          ? options.queue.enqueueRuntimeNotice(held.text, held.key)
          : options.queue.enqueue(held.text, { silent: true, ...(held.key ? { backgroundNotificationId: held.key } : {}) })
        if (!admitted) {
          // The hold survives the closed input boundary for durable recovery.
          refused = { cause: new Error("Background notification was not admitted after handoff") }
        } else if (held.key !== undefined) committed = options.conversation.waitForBackgroundNotification(held.key)
      }).catch((cause: unknown) => {
        refused = { cause }
        failure ??= refused
        options.abort()
      })
      const delivery = tail.then(() => {
        if (refused) throw refused.cause
        return committed
      })
      if (key !== undefined) pending.set(key, delivery)
      // The return value is optional for producers that only join admission.
      // A failed attempt releases its claim so the retained hold can retry.
      void delivery.finally(() => { if (key !== undefined) pending.delete(key) }).catch(() => {})
      return delivery
    },
    async settle(): Promise<void> {
      await tail
      if (failure) throw failure.cause
    },
  }
}

import type { ChatInput } from "../../infra/chat-input.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import type { ConversationTreeWriterController } from "../chat/tree-writer.js"
import { createHeldCellClaims, readConversationQueuedUserInputs } from "../session/conversation/queued-user-inputs.js"
import { readConversationBackgroundNotifications } from "../session/conversation/queued-background-notifications.js"
import { settleUnreadMessages, wakeAfterSettlement } from "../session/session-input-delivery.js"
import { liveSessionControl, messageDisposition, type LiveSessionControl } from "../session/live-session-control.js"
import type { WorkflowInjectionQueue } from "./injection-queue.js"
import type { createBackgroundNotificationDelivery } from "../runner/background-notification-delivery.js"

/** Owns private member input claims through live delivery, recovery, and terminal unread returns. Aggregate direction never enters this owner. */
export function createWorkflowMemberInputs(input: {
  readonly sessionId: string
  readonly conversationId: string
  readonly reader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly tree: ConversationTreeWriterController
  readonly deactivate: () => Promise<void>
  readonly queue: WorkflowInjectionQueue
  readonly notifications: Pick<ReturnType<typeof createBackgroundNotificationDelivery>, "enqueue" | "settle">
}) {
  const claims = createHeldCellClaims()
  let deactivation: Promise<void> | undefined
  const deactivate = (): Promise<void> => { deactivation ??= input.deactivate(); return deactivation }
  const withInputAdmission: NonNullable<LiveSessionControl["withInputAdmission"]> = async (admit) =>
    input.queue.isHandingOff ? { status: "refused", reason: "handing_off" } : admit()
  const notify: LiveSessionControl["notify"] = async (notification) => {
    if (input.queue.isHandingOff) return false
    void input.notifications.enqueue(notification.text, notification.key).catch(() => {})
    await input.notifications.settle()
    return !input.queue.isHandingOff
  }
  return {
    withInputAdmission,
    notify,
    claimDelivery: (message: ChatInput) => claims.claimMessage(message),
    async continueHeld(): Promise<void> {
      const control = liveSessionControl(input.reader, input.sessionId)
      if (!control) return
      for (const cell of await readConversationQueuedUserInputs(input.reader, input.sessionId, input.conversationId)) {
        if (cell.producer?.kind === "session") continue
        await control.deliver({
          text: cell.text, dispatchIds: [cell.key], attachments: cell.attachments, invocation: cell.invocation,
          submissionIds: cell.submissionIds, producer: cell.producer,
        }, state => messageDisposition({ state, origin: "human", hop: 0, self: false }))
      }
    },
    deactivate,
    async adopt(): Promise<boolean> {
      const messages = await readConversationQueuedUserInputs(input.reader, input.sessionId, input.conversationId)
      for (const cell of messages) {
        if (claims.claim(cell.key) && await input.tree.commitQueuedUserInput(cell) === "contended") break
      }
      const notices = await readConversationBackgroundNotifications(input.reader, input.sessionId, input.conversationId)
      // A notice the agent's own background work held is on its way through
      // the agent's input already, which commits it under its key.
      const adopted = notices.filter((notice) => !input.tree.holdsBackgroundNotification(notice.key))
      for (const notice of adopted) await input.tree.commitBackgroundNotification(notice)
      return messages.length > 0 || adopted.length > 0
    },
    async settle(): Promise<void> {
      await input.tree.endTurn()
      await deactivate()
      const settlement = await settleUnreadMessages(input, {
        recipientSessionId: input.sessionId, reason: "settled", end: async () => true,
        commitHeld: async (cells) => { for (const cell of cells) await input.tree.commitQueuedUserInput(cell) },
      })
      if (settlement.stored) await wakeAfterSettlement(input.reader, input.sessionId, settlement.returned)
    },
  }
}

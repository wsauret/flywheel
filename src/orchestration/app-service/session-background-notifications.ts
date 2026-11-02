import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import { completionWorkIds } from "../agent-runtime/background-work-notifications.js"
import type { ChatRunner } from "../chat/runner-types.js"
import { createConversationTreeWriterController } from "../chat/tree-writer.js"
import type { SessionEntry, SessionStore } from "../session-store/types.js"
import type { ParentNotificationDelivery } from "../module-seams.js"
import { readConversationBackgroundNotifications, type HeldBackgroundNotification } from "../session/conversation/queued-background-notifications.js"
import { liveWorkflowControl } from "../session/live-session-control.js"

type NotifiableEntry = SessionEntry

interface BackgroundNotificationDeliveryContext {
  readonly sessionId: string
  readonly projectRoot: string
  readonly eventStore: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly eventWriter: AsyncEventWriter
  /** The session owner closes admission before teardown joins durable work. */
  readonly admitsDelivery: () => boolean
  /** The parent's reconciliation, which reads a committed completion and
   *  acknowledges the child's end. */
  readonly sweepAfterCommit: () => void
}

/** Where a child's completion notice reaches one parent session. An attached
 *  runner takes it live; a session with no runner commits it to the durable
 *  conversation tree, so the next runner reads it as context. Notices the
 *  reconciliation held while no runner was attached drain the same way. */
export interface BackgroundNotificationDelivery {
  deliver(entry: NotifiableEntry, notification: HeldBackgroundNotification): Promise<boolean>
  drainHeld(entry: NotifiableEntry): Promise<void>
}

export function createBackgroundNotificationDelivery(ctx: BackgroundNotificationDeliveryContext): BackgroundNotificationDelivery {
  async function commit(
    conversationId: string,
    notification: Parameters<ChatRunner["deliverBackgroundNotification"]>[0],
  ): Promise<boolean> {
    const treeWriter = createConversationTreeWriterController({
      conversationId,
      sessionId: ctx.sessionId,
      projectRoot: ctx.projectRoot,
      store: ctx.eventStore,
      projectionReader: ctx.projectionReader,
      writer: ctx.eventWriter,
    })
    try {
      return await treeWriter.commitBackgroundNotification(notification) !== null
    } finally {
      await treeWriter.dispose()
    }
  }

  async function deliver(entry: NotifiableEntry, notification: HeldBackgroundNotification): Promise<boolean> {
    if (!ctx.admitsDelivery()) return false
    if (entry.runner) return entry.runner.deliverBackgroundNotification(notification)
    const committed = await commit(entry.conversationId, notification)
    // A workflow's runner waits for a parent sweep that reads its completion
    // in the conversation (`offerChildCompletion`). Without one, the next
    // runner of this session tracks the finished workflow again as work it
    // waits on, and its turn never comes to rest.
    const { key } = notification
    if (committed && key !== undefined && completionWorkIds(key).some((id) => liveWorkflowControl(ctx.eventStore, id))) ctx.sweepAfterCommit()
    return committed
  }

  async function drainHeld(entry: NotifiableEntry): Promise<void> {
    for (const notification of await readConversationBackgroundNotifications(ctx.projectionReader, ctx.sessionId, entry.conversationId)) {
      await deliver(entry, notification)
    }
  }

  return { deliver, drainHeld }
}

/** The composition's delivery of a child's completion notice to a parent
 *  outside the parent's own reconciliation, such as a person's Stop or
 *  deletion of the child. An attached runner takes it as `deliver` gives it,
 *  without waiting for the parent's actor, because the parent's running turn
 *  can be the one that waits on the child. A parent with no runner here
 *  keeps the notice held for its next activation, message, or Resume. */
export function attachedRunnerDelivery(sessionStore: Pick<SessionStore, "get">): ParentNotificationDelivery {
  return async (sessionId, notification) => {
    const entry = sessionStore.get(sessionId)
    return entry?.runner ? await entry.runner.deliverBackgroundNotification(notification) : false
  }
}

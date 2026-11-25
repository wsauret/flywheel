import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../../infra/substrate/store/event-store-types.js"
import { completionWorkIds } from "../../session/control/background-work/background-work-notifications.js"
import { createConversationTreeWriterController } from "../../chat/tree-writer.js"
import type { SessionEntry, SessionStore } from "../../session-store/types.js"
import type { ParentNotificationDelivery } from "../../module-contract/module-seams.js"
import { readConversationBackgroundNotifications, type HeldBackgroundNotification } from "../../session/conversation/queued-background-notifications.js"
import { liveWorkflowControl } from "../../session/control/live-session-control.js"

type NotifiableEntry = SessionEntry

interface BackgroundNotificationDeliveryContext {
  readonly sessionId: string
  readonly projectRoot: string
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
  /** Delivers every held notice. With no runner attached, answers whether a
   *  question waits, which keeps every notice held, and whether the drain
   *  committed a notice (`landed`). No runner shows what such a commit lands,
   *  which includes each held message that it lands ahead of the notice, so
   *  the caller reads the open display again. */
  drainHeld(entry: NotifiableEntry): Promise<{ readonly questionWaits: boolean; readonly landed: boolean }>
}

export function createBackgroundNotificationDelivery(ctx: BackgroundNotificationDeliveryContext): BackgroundNotificationDelivery {
  async function withWriter<T>(conversationId: string, use: (treeWriter: ReturnType<typeof createConversationTreeWriterController>) => Promise<T>): Promise<T> {
    const treeWriter = createConversationTreeWriterController({
      conversationId,
      sessionId: ctx.sessionId,
      projectRoot: ctx.projectRoot,
      store: ctx.projectionReader,
      projectionReader: ctx.projectionReader,
      writer: ctx.eventWriter,
    })
    try {
      return await use(treeWriter)
    } finally {
      await treeWriter.dispose()
    }
  }

  async function commit(treeWriter: ReturnType<typeof createConversationTreeWriterController>, notification: HeldBackgroundNotification): Promise<boolean> {
    const committed = await treeWriter.commitBackgroundNotification(notification) !== null
    // A workflow's runner waits for a parent sweep that reads its completion
    // in the conversation (`offerChildCompletion`). Without one, the next
    // runner of this session tracks the finished workflow again as work it
    // waits on, and its turn never comes to rest.
    const { key } = notification
    if (committed && key !== undefined && completionWorkIds(key).some((id) => liveWorkflowControl(ctx.projectionReader, id))) ctx.sweepAfterCommit()
    return committed
  }

  async function deliver(entry: NotifiableEntry, notification: HeldBackgroundNotification): Promise<boolean> {
    if (!ctx.admitsDelivery()) return false
    if (entry.runner) return entry.runner.deliverBackgroundNotification(notification)
    return withWriter(entry.conversationId, (treeWriter) => commit(treeWriter, notification))
  }

  async function drainHeld(entry: NotifiableEntry): Promise<{ readonly questionWaits: boolean; readonly landed: boolean }> {
    if (entry.runner) {
      for (const notification of await readConversationBackgroundNotifications(ctx.projectionReader, ctx.sessionId, entry.conversationId)) await deliver(entry, notification)
      return { questionWaits: false, landed: false }
    }
    // One writer decides the hold once: behind a waiting question every
    // notice stays in its cell, and the drain reads none of them
    // (ARCH-SESSIONS-050).
    return withWriter(entry.conversationId, async (treeWriter) => {
      if (await treeWriter.awaitsAnswer()) return { questionWaits: true, landed: false }
      let landed = false
      for (const notification of await readConversationBackgroundNotifications(ctx.projectionReader, ctx.sessionId, entry.conversationId)) {
        if (!ctx.admitsDelivery()) break
        if (await commit(treeWriter, notification)) landed = true
      }
      return { questionWaits: false, landed }
    })
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

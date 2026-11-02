import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import type { ConversationTreeWriterController } from "../chat/tree-writer.js"
import { readWorkflowBackgroundNotifications } from "../session/conversation/queued-background-notifications.js"
import { readWorkflowQueuedUserInputs } from "../session/conversation/queued-user-inputs.js"

/** Commit held workflow input at the consumer's initial idle boundary, before starting its runner,
 * and then the notices held for the workflow's next agent.
 * Stop at the first contended input cell, retaining it and later cells for a later idle invocation.
 * `claim` decides, synchronously before each commit, whether this consumer takes a cell;
 * a cell it declines is another consumer's. Storage failures reject. True means CONTEXT
 * REFRESH NEEDED: a nonempty snapshot was observed, even if another writer won or no input
 * committed here. It is not a delivery count. */
export async function consumeWorkflowRecoveryInputs(
  store: AsyncEventStateReadSurface,
  sessionId: string,
  treeWriter: ConversationTreeWriterController,
  claim: (key: string) => boolean,
): Promise<boolean> {
  const inputs = await readWorkflowQueuedUserInputs(store, sessionId)
  for (const cell of inputs) {
    if (!claim(cell.key)) continue
    if (await treeWriter.commitQueuedUserInput(cell) === "contended") return true
  }
  const notices = await readWorkflowBackgroundNotifications(store, sessionId)
  for (const notice of notices) {
    if (claim(notice.key)) await treeWriter.commitBackgroundNotification(notice)
  }
  return inputs.length > 0 || notices.length > 0
}

import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import { tryOpenConversationTree } from "./conversation/conversation-tree-handle.js"

/** Opens a completion's parent tree. An absent tree returns null. A tree
 *  with a fact that this build cannot decode throws, so no completion
 *  publishes into a history that it cannot read. The tree's own fold records
 *  each undecodable fact as a degraded gap, so this reads the held tree and
 *  folds the conversation no second time. */
export async function readChildCompletionConversation(
  context: {
    readonly input: {
      readonly reader: AsyncEventStateReadSurface
      readonly projectionReader?: AsyncEventStateReadSurface
      readonly writer: AsyncEventWriter
    }
  },
  sessionId: string,
  conversationId: string,
) {
  const { input } = context
  const tree = await tryOpenConversationTree({
    conversationId,
    sessionId,
    store: input.projectionReader ?? input.reader,
    writer: input.writer,
  })
  if (!tree?.getStorage().openedState().degraded.unreadable) return tree
  tree.getStorage().dispose()
  throw new Error(`Conversation ${conversationId} holds a fact this build cannot decode; the child completion is not published`)
}

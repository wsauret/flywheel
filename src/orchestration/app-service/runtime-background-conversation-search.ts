import type { Log } from "../../infra/log.js"
import { loggedOperation } from "../../infra/operation-log.js"
import type { RecallInput, RecallResult } from "../../protocol/conversation-recall.js"
import type { RuntimeBackgroundClient } from "./worker-background-client.js"

export interface RuntimeBackgroundConversationSearch {
  recall(conversationId: string, contract: RecallInput): Promise<RecallResult>
}

/** Keeps conversation-memory vocabulary out of the generic history lane. */
export function createRuntimeBackgroundConversationSearch(
  projectRoot: string,
  log: ReturnType<typeof Log.create>,
  client: () => RuntimeBackgroundClient,
): RuntimeBackgroundConversationSearch {
  return {
    recall: (conversationId, contract) => loggedOperation(
      { log, operation: "runtime background conversation search", level: "debug", fields: { projectRoot, conversationId } },
      () => client().recall(conversationId, contract),
    ),
  }
}

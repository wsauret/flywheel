import type { ChatModuleHost, ChatModuleHostInput } from "../../chat-module-host.js"
import { moduleRuntimeHandle } from "../../../infra/module-runtime.js"
import { createLearningReview } from "./learning-review.js"
import { learningAuditStores, reconcileLearning } from "./reconciliation.js"
import { learningReviewPolicy } from "./config.js"

export const learningChatHost = moduleRuntimeHandle<ChatModuleHost>("learning")

/** The optional review and its reconciliation belong to one admitted chat
 * host. The session's background scope owns the review fork. */
export function createChatLearningReview(input: ChatModuleHostInput): ChatModuleHost | undefined {
  const { deps } = input
  if (!deps.reviewConfig || !deps.capabilityAccess) return undefined
  const { sessionId, projectRoot, userDataRoot, accountHome } = deps
  const readNode = deps.infra.projectionReader.readSessionContentNode?.bind(deps.infra.projectionReader)
  const review = createLearningReview({
    sessionId,
    config: learningReviewPolicy(deps.reviewConfig),
    capabilities: deps.capabilityAccess,
    sessionEventWriter: deps.infra.sessionEventWriter,
    readContentNode: readNode
      ? hash => readNode(sessionId, hash)
      : undefined,
    moduleSelection: deps.moduleSelection,
    spawnReview: async (spec) => {
      const { createLearningReviewSpawner } = await import("./chat-review-spawn.js")
      return createLearningReviewSpawner(input)(spec)
    },
  })
  let replayed = false
  return {
    async beforeTurn() {
      await reconcileLearning({
        sessionId,
        conversationId: deps.conversationId,
        store: deps.infra.projectionReader,
        writer: deps.infra.sessionEventWriter,
        projectRoot,
        auditStores: learningAuditStores({ projectRoot, userDataRoot, accountHome }),
        appendSystemTurn: async (content) => { await deps.treeWriter.commitSystemTurn(content) },
        capabilities: deps.capabilityAccess,
      })
    },
    async replay(messages) { if (!replayed) { replayed = true; await review.replay(messages) } },
    noteAssistantMessage: review.noteAssistantMessage,
    noteUserTurn: review.noteUserTurn,
    onTurnCompleted: (config) => review.onTurnCompleted(config ? learningReviewPolicy(config) : undefined),
    review() { review.learn(); return true },
    dispose: review.settled,
  }
}

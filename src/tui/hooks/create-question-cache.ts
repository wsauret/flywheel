import type { AttachedRuntimeClient } from "../../protocol/app-service-types.js"
import { isQuestionPayload, questionCursor, type PendingQuestionView } from "../../protocol/question-protocol-types.js"
import { createPerSessionCache, type PerSessionCache } from "./create-per-session-cache.js"

export type QuestionCache = PerSessionCache<PendingQuestionView>

export function createQuestionCache(deps: { appService: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane"> }): QuestionCache {
  return createPerSessionCache({
    domain: "question",
    cursor: questionCursor,
    client: deps.appService,
    query: (sessionIds) => deps.appService.query({ type: "questionSnapshot", sessionIds }),
    isPayload: isQuestionPayload,
    payloadView: (payload) => (payload.kind === "question.updated" ? payload.question : null),
  })
}

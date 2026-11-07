import type { ChatModuleHostInput } from "../../chat-module-host.js"
import { resolveSessionDir } from "../../../infra/paths.js"
import { createAgentHost } from "../../runner/host.js"
import { requireRole } from "../../config/roles.js"
import { renderSkillRecommendationNotification } from "./reconciliation.js"
import { createReviewUsageAccounting, resolveReviewRoute, reviewReplay, type ReviewRunSpec, type SpawnedReview } from "./learning-review.js"
import { createLearningReviewExecution } from "./learning-review-runner.js"
import { reviewForkInstruction } from "./skill-load-stats.js"

/** Builds the one-shot learning review fork for a chat session. */
export function createLearningReviewSpawner(input: ChatModuleHostInput): (spec: ReviewRunSpec) => Promise<SpawnedReview | undefined> {
  const { deps, state, emit, background, foregroundBashHold, mailbox, applyNestedStoredFact, hasActiveTurn } = input
  const { projectRoot, executionCwd, sessionId, userDataRoot, accountHome } = deps
  // The fork replays the parent's durable conversation under the parent's
  // provider cache slot and prompt identity, so re-reading the whole session
  // costs cache reads. It exposes no progress or model activity; a successful
  // skill mutation can append one filtered system message after completion.
  return async function spawnLearningReview(spec: ReviewRunSpec): Promise<SpawnedReview | undefined> {
    if (state.ended) return undefined
    const roles = await deps.resolveRoles()
    // A Learning Review model different from Chat cannot reuse the parent
    // provider conversation, so replay a compact digest. The same model keeps
    // the full replay and provider continuation while using the review effort.
    const route = resolveReviewRoute(roles, requireRole(roles, "chat"))
    // The branch legitimately ends with the assistant's final response here;
    // the appended review prompt is the trailing user message that resolves it.
    const treeContext = await deps.treeWriter.buildContext({ allowAssistantTail: true })
    const replay = await reviewReplay(route, treeContext.messages)
    const instruction = await reviewForkInstruction(spec.instruction, spec.capabilities, deps.infra.projectionReader)
    const usageAccounting = createReviewUsageAccounting(spec.reviewRunId, (event) => {
      if (event.type === "model.usage.measured") emit("model.usage.measured", { sessionId, data: event.data })
      else emit("budget.stream.completed", { sessionId, data: event.data })
    })
    const reviewExecution = createLearningReviewExecution({
      resolveRoles: deps.resolveRoles,
      projectRoot,
      userDataRoot,
      accountHome,
      executionCwd,
      moduleSelection: spec.moduleSelection,
      signal: background.signal,
      onBudgetEvent: usageAccounting.observe,
      captureProviderConnection: deps.captureProviderConnection,
      treeRootSessionId: sessionId,
    })
    const done = createAgentHost({ createRunner: reviewExecution.createAgent }).runTurn({
      createContextOptions: async () => {
        await reviewExecution.prepare()
        return {
          model: route.role.model,
          effort: route.role.effort,
          providerOptions: route.role.providerOptions,
          proactiveCompactionThreshold: deps.proactiveCompactionThreshold,
          availableModels: deps.availableModels,
          resolveRoles: deps.resolveRoles,
          executionCwd,
          projectRoot,
          userDataRoot,
          accountHome,
          sessionDir: resolveSessionDir(sessionId, projectRoot),
          conversation: {
            kind: "replay",
            sessionId,
            priorMessages: [...replay, { kind: "user", content: instruction }],
            ...(state.providerConversationId && !route.routed ? { providerSessionKey: state.providerConversationId } : {}),
          },
          purpose: {
            kind: "chat-learning-review",
            review: { ...spec.learningReview, onCandidate: reviewExecution.onCandidate },
          },
          lifecycle: { kind: "one-shot", signal: background.signal },
          // A side call adds no launch value: it runs as an agent of its chat
          // tree's shared host, so it no longer reuses the chat engine's cached
          // prefix. A per-call launch value starts another Claude engine process,
          // so it belongs in HOST_SPLIT_EXCEPTIONS
          // (provider-claude-agent-sdk/agent-host/host-registry.ts) with its
          // reason. A chat is the root of its tree.
          treeRootSessionId: sessionId,
          auth: deps.auth,
          moduleSelection: () => spec.moduleSelection,
          runtimeSurfaces: { background, foregroundBashHold },
          capabilityAccess: spec.capabilityAccess,
          maxLLMCalls: spec.maxLLMCalls,

          onEvent: usageAccounting.observe,
          sessionEventWriter: deps.infra.sessionEventWriter,
          applyNestedStoredFact,
          sessionEventStore: deps.infra.eventStore,
          sessionEventReader: deps.infra.projectionReader,
          onNotification: deps.onNotification,
          captureProviderConnection: reviewExecution.captureProviderConnection,
        }
      },
      message: instruction,
      resilience: { signal: background.signal },
    })
    return {
      done: done.finally(usageAccounting.finish),
      model: route.role.model,
      usage: usageAccounting.usage,
      // Live delivery between tool batches of a logical turn in progress. A
      // parked or idle session skips it - the turn-head reconciliation sweep
      // delivers durably on the next request instead of waking the model for
      // a non-urgent notice. (A settle in the last tool batch can still ride
      // the park wake: enqueued before the park, drained by it.)
      notifyRecommendation: (recommendation) => {
        if (!hasActiveTurn() || mailbox.parked) return
        mailbox.enqueueSilentSystem(renderSkillRecommendationNotification(recommendation))
      },
      recordSystemMessage: async (notice) => {
        await deps.treeWriter.commitSystemMessage(notice)
        emit("agent.system_message.recorded", { sessionId, data: { message: notice.content, ...(notice.mutationEvidence ? { mutationEvidence: notice.mutationEvidence } : {}) } })
      },
    }
  }
}

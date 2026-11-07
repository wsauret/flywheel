import type { WorkflowReviewHost, WorkflowReviewHostInput } from "../../review-host.js"
import { createLearningReview, createReviewUsageAccounting, resolveReviewRoute, reviewReplay, type ReviewRunSpec, type SpawnedReview } from "./learning-review.js"
import { reviewForkInstruction } from "./skill-load-stats.js"
import { learningReviewPolicy } from "./config.js"
import { createConversationTreeWriterController } from "../../chat/tree-writer.js"
import { resolveWorkflowAgentRole } from "../../config/role-selection.js"
import { createAgentHost } from "../../runner/host.js"
import { resolveSessionDir } from "../../../infra/paths.js"
import type { AttemptRow } from "../../../workflows/view/types.js"

export function createWorkflowLearningReview({ deps: opts, memorySnapshot }: WorkflowReviewHostInput): WorkflowReviewHost | undefined {
  if (!opts.reviewConfig || !opts.capabilityAccess) return undefined
  const { sessionId, projectRoot, eventStore, resolveRoles, availableModels, auth, emit } = opts
  // The review outlives the attempt that triggered it, so it rides its own
  // abort scope, not the per-attempt background registry; settleLearningReview
  // is the host-disposal kill switch.
  const reviewAbort = new AbortController()
  // The attempt whose completed conversation the next fired review replays.
  // The skill counter accumulates across attempts, so the fork
  // reads the freshest finished conversation when the threshold lands.
  let lastCompleted: { attempt: AttemptRow; conversationId: string; sessionId: string; task: string } | null = null
  // No `recommendations` wiring: an agent's parent conversation is a workflow
  // transcript nobody answers questions in, so a global proposal would have no
  // interactive turn to decide it. The chat session owns that path.
  const readNode = opts.projectionReader.readSessionContentNode?.bind(opts.projectionReader)
  const learningReview = opts.reviewConfig && opts.capabilityAccess ? createLearningReview({
    sessionId,
    config: learningReviewPolicy(opts.reviewConfig),
    capabilities: opts.capabilityAccess,
    sessionEventWriter: opts.sessionEventWriter,
    readContentNode: readNode
      ? hash => readNode(sessionId, hash)
      : undefined,
    spawnReview: spawnLearningReview,
    moduleSelection: () => opts.moduleSelection,
  }) : undefined

  // Mirrors the chat fork (chat/runner-lifecycle.ts): no progress events,
  // whitelist-restricted, replaying the completed attempt's durable conversation
  // under that attempt's prompt identity. A successful skill mutation can append
  // one filtered system message. Agents of a workflow have no real user turns, so only the
  // skill half normally fires here.
  async function spawnLearningReview(spec: ReviewRunSpec): Promise<SpawnedReview | undefined> {
    const completed = lastCompleted
    if (!completed || reviewAbort.signal.aborted) return undefined
    const { createLearningReviewExecution } = await import("./learning-review-runner.js")
    if (reviewAbort.signal.aborted) return undefined
    const roles = await resolveRoles()
    const selected = resolveWorkflowAgentRole(completed.attempt, roles)
    if (!selected) return undefined
    const route = resolveReviewRoute(roles, selected)
    // An agent's finished conversation ends with its assistant handoff turn;
    // the appended review prompt is the user message that resolves it.
    const forkTree = createConversationTreeWriterController({
      conversationId: completed.conversationId,
      sessionId: completed.sessionId,
      projectRoot,
      store: eventStore,
      projectionReader: opts.projectionReader,
      writer: opts.eventWriter,
    })
    let messages
    try {
      messages = (await forkTree.buildContext({ allowAssistantTail: true })).messages
    } finally {
      await forkTree.dispose()
    }
    const replay = await reviewReplay(route, messages)
    const instruction = await reviewForkInstruction(spec.instruction, spec.capabilities, opts.projectionReader)
    const usageAccounting = createReviewUsageAccounting(spec.reviewRunId, (event) => {
      if (event.type === "model.usage.measured") emit("model.usage.measured", { sessionId, data: event.data })
      else emit("budget.stream.completed", { sessionId, data: event.data })
    })
    // The review and its audit children run on the agent host of the tree
    // that the reviewed agent belongs to, named as the agent's own identity names it.
    const treeRoot = (await opts.sessionMessaging?.identity(completed.sessionId))?.rootSessionId
    const reviewExecution = createLearningReviewExecution({
      resolveRoles,
      projectRoot,
      userDataRoot: opts.userDataRoot,
      accountHome: opts.accountHome,
      executionCwd: opts.executionCwd,
      moduleSelection: spec.moduleSelection,
      signal: reviewAbort.signal,
      onBudgetEvent: usageAccounting.observe,
      captureProviderConnection: opts.captureProviderConnection,
      ...(treeRoot === undefined ? {} : { treeRootSessionId: treeRoot }),
    })
    const done = createAgentHost({ createRunner: reviewExecution.createAgent }).runTurn({
      createContextOptions: async () => {
        await reviewExecution.prepare()
        return {
          purpose: {
            kind: "workflow-learning-review",
            review: { ...spec.learningReview, onCandidate: reviewExecution.onCandidate },
          },
          model: route.role.model,
          effort: route.role.effort,
          providerOptions: route.role.providerOptions,
          proactiveCompactionThreshold: opts.proactiveCompactionThreshold,
          availableModels,
          resolveRoles,
          executionCwd: opts.executionCwd,
          projectRoot,
          userDataRoot: opts.userDataRoot,
          accountHome: opts.accountHome,
          sessionDir: resolveSessionDir(sessionId, projectRoot),
          conversation: {
            kind: "replay",
            requestAccounting: {
              owner: { kind: "workflow", workflowId: sessionId },
              streamId: `learning-review:${spec.reviewRunId}`,
              writer: opts.sessionEventWriter,
              reader: opts.projectionReader,
            },
            priorMessages: [...replay, { kind: "user", content: instruction }],
            ...(route.routed ? {} : { providerSessionKey: completed.conversationId }),
          },
          lifecycle: { kind: "one-shot", signal: reviewAbort.signal },
          // A side call adds no launch value: it runs as an agent of its chat
          // tree's shared host. A per-call launch value starts another engine
          // process, so it belongs in HOST_SPLIT_EXCEPTIONS
          // (provider-claude-agent-sdk/agent-host/host-registry.ts) with its
          // reason.
          ...(treeRoot === undefined ? {} : { treeRootSessionId: treeRoot }),
          ...(completed.task ? { task: completed.task } : {}),
          auth,
          memorySnapshot,
          moduleSelection: () => spec.moduleSelection,
          runtimeSurfaces: {},
          capabilityAccess: spec.capabilityAccess,
          maxLLMCalls: spec.maxLLMCalls,
          onEvent: usageAccounting.observe,
          sessionEventWriter: opts.sessionEventWriter,
          onNotification: opts.onNotification,
          applyNestedStoredFact: opts.applyNestedStoredFact,
          sessionEventStore: eventStore,
          sessionEventReader: opts.projectionReader,
          captureProviderConnection: reviewExecution.captureProviderConnection,
        }
      },
      message: instruction,
      resilience: { signal: reviewAbort.signal },
    })
    return {
      done: done.finally(usageAccounting.finish),
      model: route.role.model,
      usage: usageAccounting.usage,
      // The notice lands in the agent's own session, not the workflow's.
      stageNoticeContent: async (nodes) => {
        if (!opts.eventWriter.stageSessionContentNodes) throw new Error("Session content storage is unavailable")
        await opts.eventWriter.stageSessionContentNodes(completed.sessionId, nodes)
      },
      recordSystemMessage: async (notice) => {
        const transcript = createConversationTreeWriterController({
          conversationId: completed.conversationId,
          sessionId: completed.sessionId,
          projectRoot,
          store: eventStore,
          projectionReader: opts.projectionReader,
          writer: opts.eventWriter,
        })
        try {
          await transcript.commitSystemMessage(notice)
        } finally {
          await transcript.dispose()
        }
      },
    }
  }

  let replayed = false
  return {
    async replay(messages) { if (!replayed) { replayed = true; await learningReview?.replay(messages) } },
    noteAssistantMessage: (content) => learningReview?.noteAssistantMessage(content),
    completed: ({ attempt, conversationId, sessionId: memberSessionId, task }) => { lastCompleted = { attempt, conversationId, sessionId: memberSessionId, task } },
    onTurnCompleted(conversationId, config) { if (lastCompleted?.conversationId === conversationId) learningReview?.onTurnCompleted(config ? learningReviewPolicy(config) : undefined) },
    dispose() { reviewAbort.abort(); return learningReview?.settled() ?? Promise.resolve() },
  }
}

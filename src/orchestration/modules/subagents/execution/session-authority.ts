import { readCapturedFacts, requireGuardedEventAppender, type AsyncEventStateReadSurface, type AsyncEventWriter } from "../../../../infra/event-store-types.js"
import type { RecallInput, RecallResult } from "../../../../protocol/conversation-recall.js"
import type { SessionManager } from "../../../session/manager.js"
import { prepareSessionFactAppend } from "../../../session/session-fact-writer.js"
import { acquireChildExecutionResources } from "../../../session/child-execution-resources.js"
import { errorMessage } from "../../../../infra/error-message.js"
import { Log } from "../../../../infra/log.js"
// oxlint-disable-next-line import/no-cycle -- the module authority schedules the kernel cross-session publication.
import { reconcileChildSessionCompletions } from "../../../session/child-session-reconciliation.js"
import type { HeldBackgroundNotification } from "../../../session/conversation/queued-background-notifications.js"
import { readSubagentRuns } from "../history/subagent-run-projection.js"
import { buildSubagentCompleted, buildSubagentResumed } from "../history/subagent-run-fact-writers.js"
import { buildSessionMetadataAppend } from "../../../session/session-metadata-store.js"
import { liveChildRun, registerLiveSessionControl } from "../../../session/live-session-control.js"
import { settleUnreadMessages, wakeAfterSettlement } from "../../../session/session-input-delivery.js"
// oxlint-disable-next-line import/no-cycle -- planned continuation is a kernel authorization consumed by the module run owner.
import { preparePlannedSessionContinuationConsumption, readPlannedSessionContinuationAsync } from "../../../session/planned-session-continuation.js"
import type { AttachChildSessionProjection, ChildSessionAuthority } from "../../../module-seams.js"

const log = Log.create({ service: "subagent-session-authority" })
export function createSubagentSessionAuthority(input: {
  readonly manager: Pick<SessionManager, "allocateId" | "publishSubagent" | "read" | "publishActivation" | "updateLifecycleState">
  readonly eventStore: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly eventWriter: AsyncEventWriter
  readonly projectRoot: string
  readonly recall: (conversationId: string, contract: RecallInput) => Promise<RecallResult>
  readonly attachProjection?: AttachChildSessionProjection
}): ChildSessionAuthority {
  const pendingReconciliations = new Set<Promise<void>>()
  const resolveRoles = async (sessionId: string, capture?: import("../../../agent-runtime/factory.js").ProviderConnectionCapture) => {
    const { createSessionRoleResolver } = await import("../../../config/session-role-resolver.js")
    return createSessionRoleResolver({ reader: input.projectionReader, projectRoot: input.projectRoot, sessionId })(capture)
  }
  const openExecution = async (publication: Omit<Parameters<ChildSessionAuthority["publish"]>[0], "runBinding" | "forkHistory" | "assignment">) => {
    const resources = await acquireChildExecutionResources({
      conversationId: publication.childConversationId,
      sessionId: publication.childSessionId,
      description: publication.description,
      executionCwd: publication.executionCwd,
      projectRoot: input.projectRoot,
      eventStore: input.eventStore,
      projectionReader: input.projectionReader,
      writer: input.eventWriter,
      recall: (contract) => input.recall(publication.childConversationId, contract),
      attachProjection: input.attachProjection,
    })
    return {
      ...resources,
      resolveRoles: (capture?: import("../../../agent-runtime/factory.js").ProviderConnectionCapture) => resolveRoles(publication.childSessionId, capture),
    }
  }
  const scheduleParentReconciliation = (
    parentSessionId: string,
    deliverNotification?: (notification: HeldBackgroundNotification) => Promise<boolean>,
  ): void => {
    const work = Promise.resolve().then(() => reconcileChildSessionCompletions({
        parentSessionId,
        reader: input.eventStore,
        projectionReader: input.projectionReader,
        writer: input.eventWriter,
        ...(deliverNotification ? { deliverNotification } : {}),
      })).then(() => {})
    pendingReconciliations.add(work)
    void work.then(
      () => { pendingReconciliations.delete(work) },
      (error: unknown) => {
        log.warn("parent completion reconciliation deferred", {
          parentSessionId,
          error: errorMessage(error),
        })
      },
    )
  }
  const publishOpeningFailure = async (
    publication: Parameters<typeof openExecution>[0],
    childRunId: string,
    expectedSeq: number,
    error: unknown,
  ) => {
    try {
      const result = await requireGuardedEventAppender(input.eventWriter, "Subagent opening failure requires guarded append authority").appendBatchGuarded([
        {
          ...prepareSessionFactAppend(publication.childSessionId, buildSubagentCompleted({
            childRunId, status: "failed", isError: true, content: `Subagent could not open: ${errorMessage(error)}`, durationMs: 0,
          })),
          expectedSeq,
        },
        {
          ...buildSessionMetadataAppend(publication.childSessionId, {
            type: "session.lifecycle.changed", version: 1, actor: "flywheel",
            payload: { lifecycleState: "inactive", lastUpdated: new Date().toISOString() },
          }),
          expectedSeq: expectedSeq + 1,
        },
      ])
      if (result.kind !== "stored") throw new Error("Subagent opening failure publication changed before settlement")
      scheduleParentReconciliation(publication.parentSessionId)
    } catch (publicationError) {
      // oxlint-disable-next-line preserve-caught-error -- boundary: AggregateError takes cause options in its third argument.
      throw new AggregateError([error, publicationError], `Subagent opening failure could not be recorded: ${errorMessage(error)}`, { cause: publicationError })
    }
  }
  const openPublishedExecution = async (
    publication: Parameters<typeof openExecution>[0],
    childRunId: string,
    expectedSeq: number,
  ) => {
    try {
      return {
        ...await openExecution(publication),
        failBeforeStart: (error: unknown) => publishOpeningFailure(publication, childRunId, expectedSeq, error),
      }
    } catch (error) {
      await publishOpeningFailure(publication, childRunId, expectedSeq, error)
      throw error
    }
  }

  return {
    resolveRoles,
    allocateId: () => input.manager.allocateId(),
    childDepth: async (parentSessionId) => {
      let depth = 1
      let ancestor = await input.manager.read(parentSessionId)
      if (!ancestor) throw new Error(`Parent session not found: ${parentSessionId}`)
      while (ancestor.kind === "subagent") {
        depth += 1
        ancestor = await input.manager.read(ancestor.launchedFrom.parentSessionId)
        if (!ancestor) throw new Error(`Subagent ancestor not found while resolving depth for ${parentSessionId}`)
      }
      return depth
    },
    reconcileParentCompletion: scheduleParentReconciliation,
    async settleReconciliation() {
      const failures: unknown[] = []
      while (pendingReconciliations.size > 0) {
        const accepted = [...pendingReconciliations]
        const results = await Promise.allSettled(accepted)
        for (const work of accepted) pendingReconciliations.delete(work)
        for (const result of results) {
          if (result.status === "rejected") failures.push(result.reason)
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Subagent parent reconciliation failed", { cause: failures[0] })
      }
    },
    registerLiveControl(control) {
      return registerLiveSessionControl(input.eventStore, control)
    },
    async settleUnreadMessages(settlement) {
      const outcome = await settleUnreadMessages({ reader: input.projectionReader, writer: input.eventWriter }, settlement)
      if (outcome.stored) await wakeAfterSettlement(input.projectionReader, settlement.recipientSessionId, outcome.returned)
      return outcome.stored
    },
    deactivate: (childSessionId) => input.manager.updateLifecycleState(childSessionId, "inactive"),
    async prepareResume(request) {
      const expectedSeq = await input.projectionReader.aggregateSeq(`session:${request.childSessionId}`) + 1
      const child = await input.manager.read(request.childSessionId)
      if (
        child?.kind !== "subagent"
        || child.launchedFrom.parentSessionId !== request.parentSessionId
      ) return { ok: false as const, error: "Subagent is not a current direct child of this parent" }
      if (liveChildRun(input.eventStore, request.childSessionId)) {
        return { ok: false as const, error: "Subagent is still running" }
      }
      const run = (await readSubagentRuns(input.projectionReader, request.childSessionId)).at(-1)
      const planned = run?.status === "created"
        ? await readPlannedSessionContinuationAsync(input.projectionReader, request.childSessionId)
        : null
      // Activation precedes projection attachment and live-control registration.
      // The durable active lifecycle owns that opening window.
      if (run?.status === "created" && child.lifecycleState === "active"
        && !(planned?.target.kind === "subagent" && planned.runId === run.childRunId)) {
        return { ok: false as const, error: "Subagent is already starting or running" }
      }
      if (run?.status === "completed") return { ok: false as const, error: "Subagent has already completed" }
      if (run && (run.parentSessionId !== request.parentSessionId || run.parentConversationId !== request.parentConversationId)) {
        return { ok: false as const, error: "Subagent recorded binding does not match this parent conversation" }
      }
      if (
        !run
        || !run.conversationId
        || !run.parentToolCallId
        || !run.prompt
        || !run.executionCwd
        || !run.task
        || !run.promptToolNames
        || !run.personaKind
        || !run.capabilityGrant
        || !run.admittedModuleIds
        || run.skillsRevision === undefined
        || run.maxTurns === undefined
        || run.maxTokens === undefined
      ) return { ok: false as const, error: "Subagent recorded execution context is incomplete" }
      const { parentToolCallId: parentToolUseId, ...childRun } = run
      return {
        ok: true as const,
        run: {
          ...childRun,
          conversationId: run.conversationId,
          parentSessionId: request.parentSessionId,
          parentConversationId: request.parentConversationId,
          parentToolUseId,
          prompt: run.prompt,
          executionCwd: run.executionCwd,
          task: run.task,
          promptToolNames: run.promptToolNames,
          personaKind: run.personaKind,
          capabilityGrant: run.capabilityGrant,
          admittedModuleIds: run.admittedModuleIds,
          skillsRevision: run.skillsRevision,
          maxTurns: run.maxTurns,
          maxTokens: run.maxTokens,
        },
        attempt: run.status === "created" || run.status === "paused" || run.status === "interrupted"
          ? { kind: "same_run" as const, expectedSeq }
          : { kind: "new_attempt" as const, expectedSeq },
      }
    },
    async publishNewAttempt(publication) {
      const child = await input.manager.read(publication.childSessionId)
      if (
        child?.kind !== "subagent"
        || child.conversationId !== publication.childConversationId
        || child.launchedFrom.parentSessionId !== publication.parentSessionId
      ) throw new Error("Subagent new attempt binding no longer matches the direct child")
      const expectedSeq = publication.runBinding.expectedSeq ?? await input.projectionReader.aggregateSeq(`session:${publication.childSessionId}`) + 1
      await input.manager.publishActivation(publication.childSessionId, [{ ...publication.runBinding, expectedSeq }, publication.promptFact])
      return openPublishedExecution(publication, String(publication.runBinding.payload.childRunId), expectedSeq + 3)
    },
    async publishResume(publication) {
      const child = await input.manager.read(publication.childSessionId)
      if (
        child?.kind !== "subagent"
        || child.conversationId !== publication.childConversationId
        || child.launchedFrom.parentSessionId !== publication.parentSessionId
      ) throw new Error("Subagent resume binding no longer matches the direct child")
      // Preparation captures the guard before the run. A concurrent Stop or
      // Resume refuses this activation instead of opening the child twice.
      const expectedSeq = publication.expectedSeq
      const run = (await readSubagentRuns(input.projectionReader, publication.childSessionId)).at(-1)
      if (!run) throw new Error("Subagent recorded execution context is incomplete")
      const planned = await readPlannedSessionContinuationAsync(input.projectionReader, publication.childSessionId)
      if (planned?.target.kind === "subagent" && planned.runId) {
        const resumed = await preparePlannedSessionContinuationConsumption({
          reader: input.projectionReader,
          sessionId: publication.childSessionId,
          runId: planned.runId,
        })
        if (!resumed) throw new Error("Planned subagent continuation authorization changed before start")
        await input.manager.publishActivation(publication.childSessionId, [{ ...resumed, expectedSeq }])
      } else {
        if (!(run.status === "created" || run.status === "paused" || run.status === "interrupted")) {
          throw new Error("Paused subagent run changed before resume")
        }
        await input.manager.publishActivation(publication.childSessionId, [{
          ...prepareSessionFactAppend(publication.childSessionId, buildSubagentResumed({
            childRunId: run.childRunId,
            authorizationId: `explicit:${publication.parentToolUseId}`,
            continuation: (run.continuationCount ?? 0) + 1,
          })),
          expectedSeq,
        }])
      }
      return openPublishedExecution(publication, run.childRunId, expectedSeq + 2)
    },
    async publish(publication) {
      await input.manager.publishSubagent({
        id: publication.childSessionId,
        conversationId: publication.childConversationId,
        description: publication.description,
        authProfileId: publication.authProfileId,
        initialRoles: publication.initialRoles,
        executionCwd: publication.executionCwd,
        launchedFrom: {
          parentSessionId: publication.parentSessionId,
          conversationId: publication.parentConversationId,
          toolUseId: publication.parentToolUseId,
        },
        runBinding: publication.runBinding,
        promptFact: publication.promptFact,
        ...(publication.forkHistory ? { forkHistory: publication.forkHistory } : {}),
        assignment: publication.assignment,
      })
      const prompts = await readCapturedFacts(input.projectionReader, { aggregateId: `session:${publication.childSessionId}`, types: ["subagent.prompted"] })
      const prompt = prompts.find((fact) => fact.payload.childRunId === publication.promptFact.payload.childRunId)
      if (!prompt) throw new Error("Published subagent prompt is missing")
      return openPublishedExecution(publication, String(prompt.payload.childRunId), prompt.seq + 1)
    },
  }
}

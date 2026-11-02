import { Effect, Exit, Scope } from "effect"
import { ContainedDirectory } from "../../infra/descriptor-directory.js"
import { createEmit, EventBus, type EmitFn } from "../../infra/event-bus.js"
import { FLYWHEEL_EVENT_TYPES } from "../../infra/events.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import { ensureSessionDir, resolveSessionDir, sessionRelativeDir } from "../../infra/paths.js"
import type { RuntimeEvent } from "../../infra/runtime-event-types.js"
import { directoryComponents, removeTreeUnder } from "../../infra/write-file-under.js"
import type { RecallInput, RecallResult } from "../../protocol/conversation-recall.js"
import { createConversationTreeWriterController, type ConversationTreeWriterController } from "../chat/tree-writer.js"
import type { AttachChildSessionProjection, ChildSessionKind } from "../module-seams.js"
import { createSessionBudgetStore } from "./budget-store.js"
import { holdChildReconciliationIndex } from "./child-reconciliation-index.js"
import { releaseConversationTreeProjection } from "./conversation/conversation-projection.js"
import { subscribeSessionRuntimeFacts } from "./create-session-infra.js"
import { writeOwnerPid } from "./pid-lock.js"
import { createSessionFactWriter, type SessionFactWriter } from "./session-fact-writer.js"

export interface ChildExecutionResources {
  readonly sessionId: string
  readonly conversationId: string
  readonly sessionDir: string
  readonly eventStore: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly eventWriter: SessionFactWriter
  readonly conversation: ConversationTreeWriterController
  readonly projection?: Awaited<ReturnType<AttachChildSessionProjection>>
  readonly emit: EmitFn
  onEvent(event: RuntimeEvent): void
  waitForEventCapacity(signal?: AbortSignal): void | Promise<void>
  awaitDurableFacts(): Promise<void>
  /** Call after producers and nested/background work stop. Repeated calls join
   * the same close, which rejects after all resources close if any stage fails. */
  settle(): Promise<void>
}

/** Prepares the filesystem owner before guarded publication. Rollback removes
 * only a directory this call created for an exclusively held, unreserved id. */
export function prepareChildExecutionOwner(sessionId: string, projectRoot: string, reserved: boolean) {
  const relativeDir = sessionRelativeDir(sessionId)
  const existing = ContainedDirectory.openExisting(projectRoot, directoryComponents(relativeDir))
  const created = existing === undefined
  existing?.close()
  const rollback = () => {
    if (created && !reserved) removeTreeUnder(projectRoot, relativeDir)
  }
  try {
    ensureSessionDir(sessionId, projectRoot)
    writeOwnerPid(sessionId, projectRoot)
  } catch (error) {
    rollback()
    throw error
  }
  return { rollback }
}

/** Opens resources for an already published child conversation. This lease owns
 * no runner, admission, dispatch publication, or parent outcome policy.
 * Acquisition rejects after cleanup; settlement drains accepted facts and the
 * tree before disposing the observation projection and borrowed resources. */
export async function acquireChildExecutionResources(input: ChildSessionKind & {
  readonly sessionId: string
  readonly conversationId: string
  readonly description: string
  readonly executionCwd: string
  readonly projectRoot: string
  readonly eventStore: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly recall: (contract: RecallInput) => Promise<RecallResult>
  /** Commits the child's opening turn. It runs before the live view
   *  attaches, so the view's seed holds that turn: a turn the tree commits
   *  later reaches the view only through a live event. */
  readonly openConversation?: (conversation: ConversationTreeWriterController) => Promise<void>
  readonly attachProjection?: AttachChildSessionProjection
}): Promise<ChildExecutionResources> {
  const scope = Effect.runSync(Scope.make())
  const errors: unknown[] = []
  let projection: Awaited<ReturnType<AttachChildSessionProjection>> | undefined
  let settlement: Promise<void> | undefined
  const settle = (): Promise<void> => {
    settlement ??= Effect.runPromise(Scope.close(scope, Exit.void)).then(() => {
      if (errors.length > 0) throw new AggregateError(errors, "Child execution disposal failed", { cause: errors[0] })
    })
    return settlement
  }
  const acquisition = Effect.acquireRelease(Effect.sync(() => {
    const conversation = createConversationTreeWriterController({
      conversationId: input.conversationId, sessionId: input.sessionId, projectRoot: input.projectRoot,
      store: input.eventStore, projectionReader: input.projectionReader, writer: input.writer, recall: input.recall,
      ...(input.kind === "workflow-agent" ? { workflowId: input.workflowId, ownsQueuedUserInput: () => true } : {}),
    })
    // The store feeds only the card, which takes the metrics that each change
    // carries. No budget gate reads this store.
    const eventWriter = createSessionFactWriter({
      sessionId: input.sessionId, writer: input.writer,
      onStored: (fact) => budgetStore.applyStoredFact(fact),
    })
    const budgetStore = createSessionBudgetStore({
      sessionId: input.sessionId, reader: input.projectionReader, recorder: eventWriter.record,
      emitter: createEmit({ emit: (event) => { if (event.type === "budget.metrics.changed") projection?.updateMetrics(event.data) } }),
    })
    const bus = new EventBus()
    const runtimeFacts = subscribeSessionRuntimeFacts(bus, {
      sessionId: input.sessionId, sessionEventWriter: eventWriter, requireWriterBarrier: false,
    })
    // A running child can launch children of its own, so it owns its
    // completion index while it runs, as a chat's actor does.
    const releaseReconciliationIndex = holdChildReconciliationIndex(input.projectionReader, input.sessionId)
    return { conversation, eventWriter, budgetStore, bus, runtimeFacts, releaseReconciliationIndex }
  }), (resources) => Effect.promise(async () => {
    // A failed flush must not skip later releases or hide an accepted fact.
    for (const close of [
      () => resources.runtimeFacts.awaitDurableFacts(),
      () => resources.bus.dispose(),
      () => resources.runtimeFacts.unsubscribe(),
      () => resources.conversation.dispose(),
      async () => {
        const drained = await resources.eventWriter.drain?.()
        if (drained?.kind === "failed") throw new Error(drained.error.message)
      },
      () => resources.eventWriter.dispose(),
      () => resources.budgetStore.dispose(),
      () => projection?.dispose(),
      () => releaseConversationTreeProjection(input.eventStore, input.conversationId),
      () => resources.releaseReconciliationIndex(),
    ]) {
      try { await close() } catch (error) { errors.push(error) }
    }
  }))
  try {
    const resources = await Effect.runPromise(Effect.provideService(acquisition, Scope.Scope, scope))
    await input.openConversation?.(resources.conversation)
    const kind: ChildSessionKind = input.kind === "workflow-agent" ? { kind: input.kind, workflowId: input.workflowId } : {}
    projection = await input.attachProjection?.({
      ...kind,
      sessionId: input.sessionId, conversationId: input.conversationId, description: input.description,
      executionCwd: input.executionCwd, eventStore: input.eventStore, projectionReader: input.projectionReader,
    })
    projection?.updateMetrics(await resources.budgetStore.metrics())
    const emit = createEmit(resources.bus)
    resources.bus.subscribeToTypes(FLYWHEEL_EVENT_TYPES, (event) => {
      projection?.onEvent(event)
    }, { delivery: "direct", deliveryClass: "critical", label: "child-session-output" })
    return {
      sessionId: input.sessionId, conversationId: input.conversationId,
      sessionDir: resolveSessionDir(input.sessionId, input.projectRoot),
      eventStore: input.eventStore, projectionReader: input.projectionReader,
      eventWriter: resources.eventWriter, conversation: resources.conversation, projection,
      emit,
      onEvent(event) {
        // Parent correlation belongs to the compact card, except budget stream
        // identity. An event that carries none keeps its shape: a strict fact
        // schema refuses a key it does not declare.
        const data = event.type === "budget.stream.completed" || !("parent_tool_use_id" in event.data) ? event.data : { ...event.data, parent_tool_use_id: undefined }
        emit(event.type, { sessionId: input.sessionId, data })
      },
      waitForEventCapacity: (signal) => resources.bus.waitForCapacity(signal),
      awaitDurableFacts: () => resources.runtimeFacts.awaitDurableFacts(),
      settle,
    }
  } catch (error) {
    try {
      await settle()
    } catch (cleanupError) {
      // oxlint-disable-next-line preserve-caught-error -- boundary: AggregateError takes cause options in its third argument.
      throw new AggregateError([error, cleanupError], "Child execution opening and cleanup failed", { cause: cleanupError })
    }
    throw error
  }
}

import { Effect } from "effect"
import type { Scope } from "effect/Scope"
import type { EmitFn, EventBus } from "../../infra/event-bus.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import { EventReaderService, EventStoreWriterLaneService, EventStoreWriterService } from "../../infra/event-store-effect.js"
import type { BudgetLimits } from "../../workflows/budget.js"
import { createWorkflowContextStore as defaultCreateWorkflowContextStore, type WorkflowContextStore } from "../../workflows/context-bundle/context-store.js"
import { createWorkflowViewStore as defaultCreateWorkflowViewStore, type WorkflowViewStore } from "../../workflows/view/view-store.js"
import { createSessionBudgetStore as defaultCreateSessionBudgetStore } from "./budget-store.js"
import type { SessionBudgetStore } from "./budget-store-types.js"
import type { SessionFactWriter } from "./session-fact-writer.js"
import { createSessionFactWriter as defaultCreateSessionFactWriter } from "./session-fact-writer.js"
import { createSessionToolExecutionStore as defaultCreateSessionToolExecutionStore } from "./tool-execution-store.js"
import type { SessionToolExecutionStore } from "./tool-execution-types.js"
import type { DurableOwner } from "../../infra/durable-owner.js"


export interface SessionResourceLifecycle {
  drainEventBus(): Promise<void>
  drainWriter(): Promise<void>
  disposeProjections(): void
}

export interface SessionResources {
  budgetStore: SessionBudgetStore
  sessionEventWriter: SessionFactWriter
  toolExecutionStore: SessionToolExecutionStore
  queueStore: WorkflowViewStore
  contextStore: WorkflowContextStore
  eventStore: AsyncEventStateReadSurface
  projectionReader: AsyncEventStateReadSurface
  eventWriter: AsyncEventWriter
  lifecycle: SessionResourceLifecycle
}

export interface AcquireSessionResourcesDeps {
  sessionId: string
  owner?: DurableOwner
  projectRoot: string
  emitter: EmitFn
  /** Private bus drain: registered in this resource scope so subscriber work
   *  finishes before stores/writer lanes close, without adding a public event. */
  eventBus?: EventBus
  budgetLimits?: BudgetLimits
  projectionReader: AsyncEventStateReadSurface
  /** Forwarded to `createSessionToolExecutionStore`: invoked when the
   *  projection-derived active-subagent set changes. Consumers push it onto
   *  their session entry to drive the tab "busy" signal. */
  onActiveSubagentsChanged?: (ids: ReadonlySet<string>) => void
  /** Factory overrides for testing; production callers omit these. */
  factories?: {
    createSessionBudgetStore?: typeof defaultCreateSessionBudgetStore
    createSessionFactWriter?: typeof defaultCreateSessionFactWriter
    createSessionToolExecutionStore?: typeof defaultCreateSessionToolExecutionStore
    createWorkflowViewStore?: typeof defaultCreateWorkflowViewStore
    createWorkflowContextStore?: typeof defaultCreateWorkflowContextStore
  }
}

/**
 * Acquire all session resources as a single scoped Effect.
 *
 * LIFO disposal means last-acquired/finalizer-registered releases first.
 * Acquisition/finalizer order:
 *   session events → budget → domain stores → eventBus drain
 *
 * Produces disposal order:
 *   eventBus drain → domain stores → budget (dispose)
 *   → session events (drain+dispose)
 * After the private bus drain, this matches ARCH-RUNTIME-029: finalize → flush → dispose.
 */
export function acquireSessionResources(
  deps: AcquireSessionResourcesDeps,
): Effect.Effect<SessionResources, never, Scope | EventReaderService | EventStoreWriterLaneService | EventStoreWriterService> {
  const { sessionId } = deps
  const createSessionBudgetStore = deps.factories?.createSessionBudgetStore ?? defaultCreateSessionBudgetStore
  const createSessionFactWriter = deps.factories?.createSessionFactWriter ?? defaultCreateSessionFactWriter
  const createSessionToolExecutionStore = deps.factories?.createSessionToolExecutionStore ?? defaultCreateSessionToolExecutionStore
  const createWorkflowViewStore = deps.factories?.createWorkflowViewStore ?? defaultCreateWorkflowViewStore
  const createWorkflowContextStore = deps.factories?.createWorkflowContextStore ?? defaultCreateWorkflowContextStore

  // Aggregates per-finalizer failures so Effect's LIFO chain runs to
  // completion (catching re-throws inside each finalizer is mandatory;
  // re-throwing skips remaining finalizers and loses data per CLAUDE.md §6).
  // The first finalizer registered runs LAST, so we register the aggregate
  // check here to surface a single `AggregateError` after all cleanup is done.
  const disposeErrors: unknown[] = []
  let eventBusDisposed = false
  let writerDisposed = false
  let projectionsDisposed = false

  return Effect.gen(function* () {
    // Registered first → runs last. Throws the aggregate after every other
    // finalizer has had a chance to clean up.
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      if (disposeErrors.length > 0) {
        throw new AggregateError(disposeErrors, "Session dispose failed")
      }
    }))


    // Chat and workflow runners share this writer boundary; provider clients do
    // not acquire independent production SQLite write authority or lifecycle ownership.
    // The lane belongs to the store (single-writer funnel): sessions take
    // leases on it and never own its lifecycle.
    const eventStore = yield* EventReaderService
    const eventWriter = yield* EventStoreWriterService
    const writerLane = yield* EventStoreWriterLaneService

    const sessionEventWriter = yield* Effect.acquireRelease(
      Effect.sync(() => createSessionFactWriter({
        ...(deps.owner ? { owner: deps.owner } : { sessionId }),
        writer: eventWriter,
        lane: writerLane.lease(deps.owner ?? { kind: "session", sessionId }),
        onStored: (fact): Promise<void> => budgetStore.applyStoredFact(fact),
      })),
      (writer) => Effect.promise(async () => {
        if (writerDisposed) return
        try {
          const result = await writer.drain?.()
          if (result?.kind === "failed") disposeErrors.push(new Error(result.error.message))
        } catch (err) {
          disposeErrors.push(err)
        }
        try {
          writer.dispose()
        } catch (err) {
          disposeErrors.push(err)
        }
      }),
    )


    const budgetStore = yield* Effect.acquireRelease(
      Effect.sync(() => createSessionBudgetStore({
        sessionId,
        owner: deps.owner,
        emitter: deps.emitter,
        budgetLimits: deps.budgetLimits,
        reader: deps.projectionReader,
        recorder: sessionEventWriter.record,
      })),
      (store) => Effect.sync(() => { if (!projectionsDisposed) store.dispose() }),
    )


    const toolExecutionStore = yield* Effect.acquireRelease(
      Effect.sync(() => createSessionToolExecutionStore({
        sessionId,
        projectionReader: deps.projectionReader,
        emitter: deps.emitter,
        onActiveSubagentsChanged: deps.onActiveSubagentsChanged,
      })),
      (store) => Effect.sync(() => { if (!projectionsDisposed) store.dispose() }),
    )

    const queueStore = yield* Effect.acquireRelease(
      Effect.sync(() => createWorkflowViewStore({ sessionId, reader: deps.projectionReader })),
      (store) => Effect.sync(() => { if (!projectionsDisposed) store.dispose() }),
    )

    const contextStore = yield* Effect.acquireRelease(
      Effect.sync(() => createWorkflowContextStore({ sessionId, reader: deps.projectionReader })),
      (store) => Effect.sync(() => { if (!projectionsDisposed) store.dispose() }),
    )

    if (deps.eventBus) {
      const eventBus = deps.eventBus
      yield* Effect.addFinalizer(() => Effect.promise(async () => {
        if (eventBusDisposed) return
        try {
          await eventBus.dispose()
        } catch (err) {
          disposeErrors.push(err)
        }
      }))
    }

    const lifecycle: SessionResourceLifecycle = {
      async drainEventBus() {
        if (eventBusDisposed) return
        eventBusDisposed = true
        if (deps.eventBus) await deps.eventBus.dispose()
      },
      async drainWriter() {
        if (writerDisposed) return
        writerDisposed = true
        const errors: unknown[] = []
        try {
          const result = await sessionEventWriter.drain?.()
          if (result?.kind === "failed") errors.push(new Error(result.error.message))
        } catch (error) {
          errors.push(error)
        }
        try {
          sessionEventWriter.dispose()
        } catch (error) {
          errors.push(error)
        }
        if (errors.length > 0) throw new AggregateError(errors, "Session writer disposal failed")
      },
      disposeProjections() {
        if (projectionsDisposed) return
        projectionsDisposed = true
        const errors: unknown[] = []
        for (const dispose of [
          () => contextStore.dispose(),
          () => queueStore.dispose(),
          () => toolExecutionStore.dispose(),
          () => budgetStore.dispose(),
        ]) {
          try { dispose() } catch (error) { errors.push(error) }
        }
        if (errors.length > 0) throw new AggregateError(errors, "Session projection disposal failed")
      },
    }
    return { budgetStore, sessionEventWriter, toolExecutionStore, queueStore, contextStore, eventStore, projectionReader: deps.projectionReader, eventWriter, lifecycle }
  })
}


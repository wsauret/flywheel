import { createEmit, type EventBus, type Unsubscribe } from "../../infra/event-bus.js"
import { PersistenceWriteRefused, type AsyncEventStateReadSurface, type AsyncEventWriter, type StoredFact } from "../../infra/event-store-types.js"
import type { WorkflowContextStore } from "../../workflows/context-bundle/context-store.js"
import type { WorkflowViewStore } from "../../workflows/view/view-store.js"
import type { BudgetMetrics, SessionBudgetStore } from "./budget-store-types.js"
import { DebugLog } from "../../infra/debug-log.js"
import { toRuntimeEvent, type FlywheelEvent } from "../../infra/events.js"
import { DEBUG_RUNTIME_EVENT_TYPES, DURABLE_RUNTIME_EVENT_TYPES } from "../../infra/runtime-event-types.js"
import { mapRuntimeEventToDebugRecords, mapRuntimeEventToSessionRuntimeFacts } from "../../infra/runtime-fact-mapper.js"
import { extractToolContentFact } from "../../infra/tool-content-extraction.js"
import type { SessionFactWriter } from "./session-fact-writer.js"
import type { SessionToolExecutionStore } from "./tool-execution-types.js"

export interface SessionInfra {
  budgetStore: SessionBudgetStore
  sessionEventWriter: SessionFactWriter
  toolExecutionStore: SessionToolExecutionStore
  queueStore: WorkflowViewStore
  contextStore: WorkflowContextStore
  eventStore: AsyncEventStateReadSurface
  projectionReader: AsyncEventStateReadSurface
  eventWriter: AsyncEventWriter
}

export type MetricsWriter = (patch: BudgetMetrics) => void
/** Owns ordered runtime-fact persistence for one bus subscription. The failure
 *  accessor reports the first dropped write after the bus has drained. */
export interface SessionRuntimeFactSubscription {
  unsubscribe: Unsubscribe
  getPersistenceFailure(): Error | null
  /** Waits until accepted runtime events and their writer work are durable. */
  awaitDurableFacts(): Promise<void>
}

export interface WiredSessionSubscribers {
  readonly unsubscribes: readonly Unsubscribe[]
  /** Waits until durable bus listeners and their accepted writer work settle. */
  awaitDurableFacts(): Promise<void>
}
/** Maps each runtime bus event to canonical session facts, records them in
 *  order, and optionally projects each acknowledged stored event. */
export function subscribeSessionRuntimeFacts(
  bus: EventBus,
  options: {
    sessionId?: string
    /** Direct writers settle each record before acknowledgement and need no lane barrier. */
    requireWriterBarrier?: boolean
    sessionEventWriter: SessionFactWriter
    onStored?: (event: StoredFact) => void | Promise<void>
    /** Requires each record call to return its committed event. Headless
     *  evidence has no transaction owner, so a null acknowledgement is a loss. */
    requireStoredFacts?: boolean
  },
): SessionRuntimeFactSubscription {
  const emit = createEmit(bus)
  let droppedFacts = 0
  let persistenceFailure: Error | null = null

  const reportFailure = (event: FlywheelEvent, cause: unknown): void => {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    persistenceFailure ??= error
    if (error instanceof PersistenceWriteRefused) return
    droppedFacts += 1
    emit("agent.notice.changed", {
      sessionId: event.sessionId,
      data: {
        operation: {
          type: "upsert",
          notice: {
            id: "runtime-fact-persistence-drop",
            scope: "runtime-fact-persistence",
            presentation: "runtime.fact_persistence_drop",
            severity: "error",
            title: "Session history is incomplete",
            message: `${droppedFacts} runtime fact${droppedFacts === 1 ? " was" : "s were"} dropped after persistence retries: ${error.message}`,
          },
        },
      },
    })
  }

  // A successful write ends the failure streak. The emergency toast has
  // already fired and is not durable notification state.
  const reportRecovery = (event: FlywheelEvent): void => {
    droppedFacts = 0
    emit("agent.notice.changed", {
      sessionId: event.sessionId,
      data: { operation: { type: "resolve", id: "runtime-fact-persistence-drop" } },
    })
  }

  const unsubscribeDebug = bus.subscribeToTypes(DEBUG_RUNTIME_EVENT_TYPES, (event) => {
    const runtimeEvent = toRuntimeEvent(event)
    // Diagnostic families (message bodies, dispatch breadcrumbs) go to the
    // debug log; the durable loop below never sees them.
    for (const fact of mapRuntimeEventToDebugRecords(runtimeEvent)) {
      DebugLog.record({
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        type: fact.type,
        actor: fact.actor,
        payload: fact.payload,
      })
    }
  }, { deliveryClass: "diagnostic", label: "runtime-debug-records" })
  const unsubscribeFacts = bus.subscribeToTypes(DURABLE_RUNTIME_EVENT_TYPES, async (event) => {
    if (options.sessionId !== undefined && event.sessionId !== options.sessionId) return
    const runtimeEvent = toRuntimeEvent(event)
    try {
      let recordedFacts = 0
      for (const fact of mapRuntimeEventToSessionRuntimeFacts(runtimeEvent)) {
        // Large tool text leaves the payload here, where it turns durable: the
        // mapper and the live bus keep inline text, and the extracted rows
        // ride the same record() call so bytes and reference commit together.
        const extracted = extractToolContentFact(fact)
        const stored = await options.sessionEventWriter.record(extracted.fact, extracted.contentRows)
        if (!stored) {
          if (options.requireStoredFacts) throw new Error(`${fact.type} was not acknowledged by the session event writer`)
          continue
        }
        recordedFacts += 1
        await options.onStored?.(stored)
      }
      if (droppedFacts > 0 && recordedFacts > 0) reportRecovery(event)
    } catch (cause) {
      reportFailure(event, cause)
    }
  }, { deliveryClass: "durable", label: "runtime-fact-persistence" })

  return {
    unsubscribe: () => { unsubscribeDebug(); unsubscribeFacts() },
    getPersistenceFailure: () => persistenceFailure,
    async awaitDurableFacts(): Promise<void> {
      const delivery = await bus.drain({ classes: ["durable"] })
      if (delivery.kind === "timed_out") {
        throw new Error(`${delivery.pending} durable event deliveries did not settle before continuation`)
      }
      const failure = persistenceFailure
      if (failure instanceof PersistenceWriteRefused) {
        // oxlint-disable-next-line no-throw-literal -- boundary: the durable subscriber barrier preserves this retained Error subtype.
        throw failure
      }
      if (persistenceFailure) throw new Error(persistenceFailure.message, { cause: persistenceFailure })
      if (!options.sessionEventWriter.flush) {
        if (options.requireWriterBarrier !== false) throw new Error("Session writer has no durability barrier")
        return
      }
      const writer = await options.sessionEventWriter.flush()
      if (writer.kind === "failed") throw new Error(writer.error.message)
    },
  }
}
export function wireSessionSubscribers(
  bus: EventBus,
  infra: Pick<SessionInfra, "budgetStore" | "sessionEventWriter" | "toolExecutionStore">,
  metricsWriter?: MetricsWriter,
  sessionId?: string,
): WiredSessionSubscribers {

  const unsubs: Unsubscribe[] = [
    bus.subscribeToType("agent.run.started", (event) => {
      if (sessionId === undefined || event.sessionId === sessionId) infra.budgetStore.recordProcessStarted()
    }, { deliveryClass: "durable", label: "budget-process-started" }),
  ]

  if (metricsWriter) {
    unsubs.push(bus.subscribeToType("budget.metrics.changed", (e) => {
      if (sessionId === undefined || e.sessionId === sessionId) metricsWriter(e.data)
    }, { deliveryClass: "ui", label: "budget-metrics-writer" }))
  }

  const runtimeFacts = subscribeSessionRuntimeFacts(bus, {
    ...(sessionId ? { sessionId } : {}),
    sessionEventWriter: infra.sessionEventWriter,
    onStored: (stored) => infra.toolExecutionStore.applyStoredFact(stored),
  })
  unsubs.push(runtimeFacts.unsubscribe)

  return {
    unsubscribes: unsubs,
    awaitDurableFacts: runtimeFacts.awaitDurableFacts,
  }
}

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
/** Owns ordered runtime-fact persistence for one bus subscription. */
export interface SessionRuntimeFactSubscription {
  unsubscribe: Unsubscribe
  /** Completeness evidence: the first fact this subscription ever lost, which
   *  never clears. Read it after the bus has drained. */
  getPersistenceFailure(): Error | null
  /** Waits until accepted runtime events and their writer work are durable.
   *  Rejects once for each lost fact: every barrier whose drain covers the loss
   *  fails, or else the next barrier to start; after one barrier has thrown it,
   *  later barriers pass. A refusal is rethrown as its `PersistenceWriteRefused`
   *  instance. The barrier always settles the writer flush, also when it reports
   *  a loss, so the writer's retained copy of that loss is not reported again. */
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
  const state: FactPersistence = { dropStreak: 0, firstLoss: null, unreported: null, waiting: new Set() }

  // The one writer of `state` besides the barrier: called once per durable event.
  const settle = (event: FlywheelEvent, outcome: { kind: "stored" } | { kind: "lost"; error: Error }): void => {
    if (outcome.kind === "stored") {
      if (state.dropStreak === 0) return
      // A successful write ends the failure streak. The emergency toast has
      // already fired and is not durable notification state.
      state.dropStreak = 0
      emit("agent.notice.changed", {
        sessionId: event.sessionId,
        data: { operation: { type: "resolve", id: "runtime-fact-persistence-drop" } },
      })
      return
    }
    const { error } = outcome
    state.firstLoss ??= error
    state.unreported ??= error
    for (const barrier of state.waiting) barrier.loss ??= error
    if (error instanceof PersistenceWriteRefused) return
    state.dropStreak += 1
    const dropped = state.dropStreak
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
            message: `${dropped} runtime fact${dropped === 1 ? " was" : "s were"} dropped after persistence retries: ${error.message}`,
          },
        },
      },
    })
  }

  /** The writer flush of the barrier: null for an opted-out direct writer,
   *  which settles each record before acknowledgement. */
  const flushWriter = async () => {
    if (!options.sessionEventWriter.flush) {
      if (options.requireWriterBarrier !== false) throw new Error("Session writer has no durability barrier")
      return null
    }
    return options.sessionEventWriter.flush()
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
      if (recordedFacts > 0) settle(event, { kind: "stored" })
    } catch (cause) {
      settle(event, { kind: "lost", error: cause instanceof Error ? cause : new Error(String(cause)) })
    }
  }, { deliveryClass: "durable", label: "runtime-fact-persistence" })

  return {
    unsubscribe: () => { unsubscribeDebug(); unsubscribeFacts() },
    getPersistenceFailure: () => state.firstLoss,
    async awaitDurableFacts(): Promise<void> {
      const barrier: WaitingBarrier = { loss: state.unreported }
      state.waiting.add(barrier)
      const delivery = await bus.drain({ classes: ["durable"] }).finally(() => state.waiting.delete(barrier))
      if (delivery.kind === "timed_out") {
        throw new Error(`${delivery.pending} durable event deliveries did not settle before continuation`)
      }
      const { loss } = barrier
      if (loss && state.unreported === loss) state.unreported = null
      // A lane-backed writer keeps each rejected item until a barrier flushes it, and that item is
      // usually the fact behind `loss`; settling the flush here makes this barrier its only report.
      const writer = await flushWriter().catch((error: unknown) => {
        if (loss) return null
        throw error
      })
      if (loss instanceof PersistenceWriteRefused) {
        // oxlint-disable-next-line no-throw-literal -- boundary: the durable subscriber barrier preserves this retained Error subtype.
        throw loss
      }
      if (loss) throw new Error(loss.message, { cause: loss })
      if (writer?.kind === "failed") throw new Error(writer.error.message)
    },
  }
}

/** One barrier that waits for durable delivery. It reports the first loss that its bus drain covered. */
interface WaitingBarrier { loss: Error | null }

/** The persistence outcome of one subscription. Each field is a different fact
 *  with its own lifetime:
 *  - dropStreak: events dropped since the last event that committed a fact; it alone drives the notice.
 *  - firstLoss: the first fact this subscription ever lost; it never clears (record completeness).
 *  - unreported: the oldest loss that no barrier has thrown yet.
 *  - waiting: the barriers whose bus drain is pending; each loss is given to each of them. */
interface FactPersistence {
  dropStreak: number
  firstLoss: Error | null
  unreported: Error | null
  readonly waiting: Set<WaitingBarrier>
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

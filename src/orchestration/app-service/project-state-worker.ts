import { pack } from "msgpackr"
import type { StartupReached } from "../../protocol/startup-steps.js"
import { ManagedRuntime } from "effect"
import { errorMessage } from "../../infra/error-message.js"
import { DebugLog } from "../../infra/debug-log.js"
import { Log } from "../../infra/log.js"
import { coalesceRepeats } from "../../infra/repeat-coalescer.js"
import { durationMs } from "../../infra/operation-log.js"
import { asAsyncEventReadSurface, CorruptEventRowError, InFlightSwapConflictError, pageReadQuery, type AsyncEventStateReadSurface, type EventStoreReadSurface, type EventStoreWriteItem, type FactQuery, type FoldEvidenceRequest, type GuardedAppendResult, type StoredFact } from "../../infra/event-store-types.js"
import { EventReaderService, EventStoreLive, EventStoreWriterLaneService, EventStoreWriterService, LocalEventStoreService, type LocalEventStoreRuntime } from "../../infra/event-store-effect.js"
import { isStorageFailure } from "../../infra/storage-failure.js"
import { prepareWorkspaceState, type WorkspaceStatePreparation } from "../workspace-state.js"
import type { SessionMetadataChange } from "../session/manager.js"
import { sessionsWrittenBy, type ProjectStateSessionsService } from "./project-state-sessions.js"
import { projectStateComposition } from "./project-state-recovery.js"
import { recoveryOwnersOf } from "./session-recovery-gate.js"
import {
  boundedProjectStatePage,
  boundedProjectStateSlice,
  decodeProjectStateRequest,
  degradedStoredFact,
  encodeProjectStateResponse,
  encodeProjectStateFact,
  encodeProjectStateClosed,
  encodeProjectStateSessionChange,
  encodeProjectStateStored,
  encodeProjectStateStartupStep,
  PROJECT_STATE_MAX_BYTES,
  PROJECT_STATE_MAX_QUEUED_ITEMS,
  operationUnits,
  type ProjectStateAdmission,
  type ProjectStateControlOperation,
  type ProjectStateContentRow,
  type ProjectStateLane,
  type ProjectStateOperation,
  type ProjectStateResponse,
  type ProjectStateResult,
  type ProjectStateServed,
  type ProjectStateSettlement,
  type ProjectStateWorkerInit,
} from "./project-state-protocol.js"
import type { WorkerSelf } from "./bun-worker-rpc.js"
import { retainedOperationKinds } from "../session/module-session-operations.js"
import { PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND } from "../session/planned-session-continuation.js"
import { projectStateFactReferences, readProjectStateContent } from "./project-state-content.js"
import { createMutationEvidenceRecovery } from "../session/mutation-evidence-recovery.js"

interface QueueEntry {
  readonly queuedAt: number
  readonly onServed?: (timing: { queueWaitMs: number; serviceMs: number }) => void
  /** A client's operation, or the Worker's own background task. */
  readonly work: { readonly kind: "operation"; readonly operation: ProjectStateOperation } | { readonly kind: "task"; run(): Promise<void> }
  readonly admission: { readonly bytes: number; readonly units: number }
  readonly resolve: (served: ProjectStateServed) => void
}

interface LaneQueues {
  readonly control: QueueEntry[]
  readonly execution: QueueEntry[]
}

interface LaneTotals {
  readonly control: { items: number; bytes: number }
  readonly execution: { items: number; bytes: number }
}

export function createProjectStateScheduler(
  execute: (operation: ProjectStateOperation) => Promise<ProjectStateServed>,
  limits: { readonly maxQueuedItems?: number; readonly maxQueuedBytes?: number } = {},
) {
  const maxQueuedItems = limits.maxQueuedItems ?? PROJECT_STATE_MAX_QUEUED_ITEMS
  const maxQueuedBytes = limits.maxQueuedBytes ?? PROJECT_STATE_MAX_BYTES
  const queues: LaneQueues = { control: [], execution: [] }
  const totals: LaneTotals = {
    control: { items: 0, bytes: 0 },
    execution: { items: 0, bytes: 0 },
  }
  let running = false
  let closing = false
  const joined = Promise.withResolvers<void>()

  async function drain(): Promise<void> {
    if (running) return
    running = true
    try {
      for (;;) {
        const lane: ProjectStateLane | undefined = queues.control.length > 0 ? "control" : queues.execution.length > 0 ? "execution" : undefined
        if (!lane) return
        const entry = queues[lane].shift()
        if (!entry) throw new Error(`project state ${lane} queue became empty before drain`)
        const startedAt = performance.now()
        let served: ProjectStateServed
        try {
          if (entry.work.kind === "operation") served = await execute(entry.work.operation)
          else {
            await entry.work.run()
            served = { result: { kind: "ok" } }
          }
        } catch (error) {
          served = { result: { kind: "failed", error: error instanceof Error ? error : new Error(errorMessage(error)) } }
        } finally {
          totals[lane].items -= entry.admission.units
          totals[lane].bytes -= entry.admission.bytes
        }
        entry.onServed?.({ queueWaitMs: Math.round((startedAt - entry.queuedAt) * 10) / 10, serviceMs: durationMs(startedAt) })
        entry.resolve(served)
        // With work still queued, let both ports deliver new control requests
        // before selecting another transaction. With none, there is nothing to
        // select: the drain ends and the next request starts it again at once.
        // The yield is an immediate, not a timer: Bun clamps a zero timer to
        // about one millisecond, which capped a backlog near a thousand
        // requests per second while the worker sat mostly idle. Port messages
        // still arrive between transactions.
        if (queues.control.length === 0 && queues.execution.length === 0) return
        await new Promise<void>((resolve) => { setImmediate(resolve) })
      }
    } finally {
      running = false
      if (closing) joined.resolve()
    }
  }

  function admit(lane: ProjectStateLane, work: QueueEntry["work"], admission: ProjectStateAdmission, onServed?: QueueEntry["onServed"]): Promise<ProjectStateServed> {
    if (closing) return Promise.resolve({ result: { kind: "failed", error: new Error("project state scheduler closed") } })
    const total = totals[lane]
    if (total.items + admission.units > maxQueuedItems || total.bytes + admission.bytes > maxQueuedBytes) {
      return Promise.resolve({ result: { kind: "refused", reason: "pressure" } })
    }
    return new Promise<ProjectStateServed>((resolve) => {
      queues[lane].push({ work, admission, resolve, queuedAt: performance.now(), onServed })
      total.items += admission.units
      total.bytes += admission.bytes
      void drain()
    })
  }

  return {
    enqueue(lane: ProjectStateLane, operation: ProjectStateOperation, admission: ProjectStateAdmission, onServed?: QueueEntry["onServed"]): Promise<ProjectStateServed> {
      return admit(lane, { kind: "operation", operation }, admission, onServed)
    },
    /** Queues the Worker's own work behind the operations already admitted,
     *  so it never runs beside one. */
    schedule(lane: ProjectStateLane, run: () => Promise<void>): Promise<ProjectStateServed> {
      return admit(lane, { kind: "task", run }, { bytes: 0, units: 1 })
    },
    close(): Promise<void> {
      closing = true
      if (!running) joined.resolve()
      return joined.promise
    },
  }
}

export interface ProjectStateServicePorts {
  readonly reader: EventStoreReadSurface
  /** Claims what the closed generation left, recording a person's interrupt
   *  for the sessions named and an unexpected exit for the rest. The claimed
   *  sessions owe recovery from then on. */
  recover(interruptedSessionIds: readonly string[]): Promise<void>
  /** The sessions that still owe recovery. */
  owedRecoveries(): readonly string[]
  /** Recovers each named session that still owes recovery. */
  settleRecovery(sessionIds: readonly string[]): Promise<void>
  appendWriteItem(item: EventStoreWriteItem): Promise<GuardedAppendResult>
  pruneSupersededEvents(aggregateId: string, eventType: string): number | Promise<number>
  pruneSupersededKeyedEvents(aggregateId: string, eventType: string, payloadKey: string): number | Promise<number>
  /** One bounded chunk of one retired family; answers the rows deleted. */
  pruneRetiredFamilyChunk(eventType: string): number | Promise<number>
  /** Drops the indexes the schema retired; answers how many it dropped. */
  dropRetiredIndexes(): number | Promise<number>
  retireFinalizedCheckpointPage(plan: Omit<Extract<ProjectStateControlOperation, { kind: "maintenance.finalized-checkpoints" }>, "kind">): Promise<Extract<ProjectStateResult, { kind: "checkpoint-maintenance" }>> | Extract<ProjectStateResult, { kind: "checkpoint-maintenance" }>
  readonly sessions: ProjectStateSessionsService
  notifySessionChange(change: SessionMetadataChange): void
  onStored(listener: (events: readonly StoredFact[]) => void): () => void
  notifyStored(events: readonly StoredFact[]): void
  close(): Promise<void>
}

/** Owns admitted operations and closes its injected state ports only after they settle. */
export function createProjectStateService(ports: ProjectStateServicePorts) {
  const recovery = createMutationEvidenceRecovery(asAsyncEventReadSurface(ports.reader), {
    stageSessionContentNodes: async (sessionId, nodes) => {
      const result = await ports.appendWriteItem({ sessionId, events: [], sessionContentNodes: nodes })
      if (result.kind !== "stored") throw new Error("Historical evidence staging conflicted")
    },
    swapInFlight: async (sessionId, kind, key, expectedRaw, payload) => {
      try {
        const result = await ports.appendWriteItem({ sessionId, events: [], inFlight: [{ op: "swap", kind, key, expectedRaw, payload }] })
        return result.kind === "stored"
      } catch (error) {
        if (error instanceof InFlightSwapConflictError) return false
        throw error
      }
    },
  })
  let storedNotifications = Promise.resolve()
  const log = Log.create({ service: "project-state-worker" })
  const notificationFailures = coalesceRepeats<{ readonly error: string }>({
    windowMs: 60_000,
    first: (_, { error }) => log.error("commit notification failed", { error }),
    repeated: (_, repeats) => log.error("commit notification failed repeatedly", { count: repeats.count, windowMs: repeats.windowMs }),
  })
  const admissionKinds = new Set([PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND, ...retainedOperationKinds()])
  async function appendAndPublishAdmission(item: EventStoreWriteItem): Promise<ProjectStateSettlement> {
    const result = await ports.appendWriteItem(item)
    if (result.kind === "stored") {
      const ids = new Set<string>()
      const affectsAdmission = (writes: EventStoreWriteItem["inFlight"]) =>
        writes?.some((write) => write.op === "clear_session" || admissionKinds.has(write.kind))
      if (affectsAdmission(item.inFlight)) ids.add(item.sessionId)
      for (const event of item.events) if (affectsAdmission(event.inFlight)) ids.add(event.sessionId)
      if (ids.size) ports.notifySessionChange({ kind: "changed", sessionIds: [...ids] })
    }
    if (result.kind !== "stored") return result
    const events = await recovery.normalizeFacts(result.events)
    // normalizeFacts preserves the input order and length, and returns a fact
    // it leaves unchanged as the same object.
    const receipts = events.map((event, index) => {
      if (event instanceof Error) throw event
      return event === result.events[index] ? { id: event.id, position: event.position, seq: event.seq } : event
    })
    return { kind: "stored", receipts }
  }
  const { reader } = ports
  const generations = new Map<string, number>()
  const closed = new Set<string>()
  const pendingRecovery = new Map<string, number>()
  const unsubscribeSessions = ports.sessions.subscribe(ports.notifySessionChange)
  const unsubscribeStored = ports.onStored((events) => {
    storedNotifications = storedNotifications.then(async () => {
      let normalized: Awaited<ReturnType<typeof recovery.normalizeFacts>>
      try {
        normalized = await recovery.normalizeFacts(events)
      } catch {
        // A failed historical conversion must not publish its original bytes
        // or poison later commit notifications. The requesting read/write
        // still reports the staging failure through its ordinary error arm.
        ports.notifyStored(events.map(event => degradedStoredFact(event, "Mutation evidence could not be staged")))
        return
      }
      // Stored notifications have no error arm. A small invalid family view
      // enters each subscriber's existing family-degraded path.
      // SAFETY: normalizeFacts preserves the dense input array's order and length.
      ports.notifyStored(normalized.map((fact, index) => fact instanceof CorruptEventRowError
        ? degradedStoredFact(events[index]!, "Mutation evidence is unavailable")
        : fact))
    }).catch((error: unknown) => {
      // Every response waits on this chain, so one failed notification must
      // not fail every later response.
      notificationFailures.observe("notify", { error: errorMessage(error) })
    })
    // Child reconciliation commits lifecycle and parent delivery in one batch,
    // outside manager commands. Publish its committed lifecycle to both clients.
    const sessionIds = [...new Set(events
      .filter((event) => event.type === "session.lifecycle.changed")
      .map((event) => event.sessionId))]
    if (sessionIds.length > 0) ports.notifySessionChange({ kind: "changed", sessionIds })
  })
  // Every response leaves after the commit notifications of the commits
  // made before it, on the same port, and carries the head read after them.
  // Operations run one at a time, so the head is at least every commit that
  // completed before the request arrived, and a reader that has heard
  // through it heard every commit of this connection at or below it (the
  // executor's commit window rests on this).
  const scheduler = createProjectStateScheduler(async (operation) => {
    const result = await serve(operation)
    await storedNotifications
    return { result, head: reader.currentPosition() }
  })
  async function serve(requestedOperation: ProjectStateOperation): Promise<ProjectStateResult> {
    try {
      let operation = requestedOperation
      if (operation.kind === "execution.operation") {
        const refusal = generationRefusal(generations, closed, operation.projectId, operation.generation)
        if (refusal) return refusal
        operation = operation.operation
      }
      switch (operation.kind) {
        case "position.capture":
          return { kind: "position", position: reader.currentPosition() }
        case "facts.latest-position":
          return { kind: "position", position: reader.readTolerant({ types: [operation.type], order: "desc", limit: 1 })[0]?.position ?? 0 }
        case "facts.latest-payload":
          return { kind: "latest-payload", payload: await recovery.reader.readLatestPayloadByAggregateAndType(operation.aggregateId, operation.type) }
        case "facts.latest-by-types":
          return { kind: "fact-list", facts: await recovery.reader.readLatestByAggregateAndTypes(operation.aggregateId, operation.types) }
        case "in-flight.read":
          return { kind: "in-flight", records: await recovery.reader.readInFlight(operation.sessionId, operation.kinds, operation.keyPrefix) }
        case "in-flight.sessions":
          return { kind: "session-ids", sessionIds: reader.sessionsWithInFlight(operation.inFlightKind) }
        case "in-flight.profile":
          return { kind: "in-flight.profile", found: reader.hasInFlightProfile(operation.inFlightKind, operation.profileId) }
        case "aggregate.count":
          return { kind: "count", count: reader.countByAggregate(operation.aggregateId) }
        case "aggregate.sequence":
          // A sequence read guards a later write: see settlingGuardReads.
          await ports.settleRecovery(recoveryOwnersOf(operation.aggregateId))
          return { kind: "sequence", sequence: reader.aggregateSeq(operation.aggregateId) }
        case "facts.slice":
          return readExactFactSlice(recovery.reader, reader, operation)
        case "facts.page": {
          if (!boundedProjectStatePage(operation.maxRows, operation.maxBytes)) return { kind: "refused", reason: "invalid" }
          const evidence = pageFoldEvidence(reader, operation.query, operation.evidence)
          const upperPosition = operation.upperPosition ?? reader.currentPosition()
          const bounds = pageReadQuery(operation.query, upperPosition, operation.afterPosition ?? 0, operation.maxRows)
          // Keep an idle replay as cheap as a position capture inside this request.
          const facts = upperPosition <= bounds.after ? [] : (await recovery.reader.readSlice(bounds.query, operation.tolerant)).facts
          const page: (StoredFact | CorruptEventRowError)[] = []
          const contentRows: ProjectStateContentRow[] = []
          let encodedBytes = 0
          for (const fact of facts) {
            if (page.length >= bounds.rows) break
            const bytes = pack(encodeProjectStateFact(fact)).byteLength
            if (encodedBytes + bytes > operation.maxBytes) {
              if (page.length === 0) return { kind: "refused", reason: "oversize" }
              break
            }
            const content = operation.content === "deferred" ? { rows: [], encodedBytes: 0, complete: true } :
              await inlineFactContent(reader, [fact], operation.maxRows - contentRows.length, operation.maxBytes - encodedBytes - bytes)
            if (!content.complete && page.length > 0) break
            page.push(fact)
            contentRows.push(...content.rows)
            encodedBytes += bytes + content.encodedBytes
            if (!content.complete) break
          }
          const continuationPosition = facts.length > page.length ? (page.at(-1)?.position ?? bounds.after) : null
          return { kind: "facts", facts: page, contentRows, upperPosition, continuationPosition, encodedBytes, ...evidence }
        }
        case "content.stage": {
          const result = await ports.appendWriteItem({ sessionId: operation.sessionId, events: [], sessionContentNodes: operation.nodes })
          if (result.kind !== "stored") throw new Error("session content staging returned a sequence conflict")
          return { kind: "ok" }
        }
        case "content.page":
        case "content.node":
        case "content.range":
          return readProjectStateContent(reader, operation)
        case "append":
          return { kind: "stored", settlements: await settleItems([operation.item], appendAndPublishAdmission) }
        case "session.control":
          await ports.settleRecovery(sessionsWrittenBy(operation.command))
          return { kind: "session-result", result: await ports.sessions.request(operation.command) }
        case "append.batch":
          return { kind: "stored", settlements: await settleItems(operation.items, appendAndPublishAdmission) }
        case "maintenance.prune":
          return { kind: "maintenance", affected: await ports.pruneSupersededEvents(operation.aggregateId, operation.eventType) }
        case "maintenance.prune-keyed":
          return { kind: "maintenance", affected: await ports.pruneSupersededKeyedEvents(operation.aggregateId, operation.eventType, operation.payloadKey) }
        case "maintenance.prune-retired":
          return { kind: "maintenance", affected: await ports.pruneRetiredFamilyChunk(operation.eventType) }
        case "maintenance.drop-retired-indexes":
          return { kind: "maintenance", affected: await ports.dropRetiredIndexes() }
        case "maintenance.finalized-checkpoints":
          return ports.retireFinalizedCheckpointPage(operation)
        case "generation.admit": {
          const current = generations.get(operation.projectId)
          if (current !== undefined && current !== operation.generation) return { kind: "refused", reason: "stale-generation" }
          const key = generationKey(operation.projectId, operation.generation)
          if (closed.has(key)) return { kind: "refused", reason: "closed-generation" }
          if (pendingRecovery.has(operation.projectId)) return { kind: "refused", reason: "unsafe-recovery", message: "Previous executor recovery has not settled" }
          generations.set(operation.projectId, operation.generation)
          return { kind: "ok" }
        }
        case "generation.close": {
          const refusal = generationRefusal(generations, closed, operation.projectId, operation.generation)
          if (refusal) return refusal
          closed.add(generationKey(operation.projectId, operation.generation))
          generations.delete(operation.projectId)
          pendingRecovery.set(operation.projectId, operation.generation)
          return { kind: "ok" }
        }
        case "generation.recover": {
          if (pendingRecovery.get(operation.projectId) !== operation.generation) return { kind: "refused", reason: "stale-generation" }
          try {
            await ports.recover(operation.interruptedSessionIds ?? [])
            pendingRecovery.delete(operation.projectId)
            scheduleRecoveries()
            return { kind: "ok" }
          } catch (error) {
            // A full disk or a held lock is a failed write, not unreadable
            // history: the person must free the disk or the lock, not repair data.
            if (isStorageFailure(error)) return { kind: "failed", error: error instanceof Error ? error : new Error(errorMessage(error)) }
            return { kind: "refused", reason: "unsafe-recovery", message: errorMessage(error) }
          }
        }
      }
    } catch (error) {
      return { kind: "failed", error: error instanceof Error ? error : new Error(errorMessage(error)) }
    }
  }
  /** Recovers each owed session in the background, one per task, after the
   *  operations already admitted. A write to an owed session that comes first
   *  recovers it at once, and its task then finds nothing to do. */
  function scheduleRecoveries(): void {
    for (const sessionId of ports.owedRecoveries()) void scheduler.schedule("execution", () => ports.settleRecovery([sessionId]))
  }
  scheduleRecoveries()
  let closing: Promise<void> | undefined
  return {
    enqueue: scheduler.enqueue,
    close(): Promise<void> {
      closing ??= scheduler.close().then(async () => {
        await storedNotifications
        notificationFailures.end()
        unsubscribeSessions()
        try {
          await ports.close()
        } finally {
          unsubscribeStored()
        }
      })
      return closing
    },
  }
}

/** A start that fails is reported as the Worker's close, with its error.
 *  Bun gives the parent of an uncaught Worker exception only a formatted
 *  source excerpt, so a failure left to throw reaches the person as a code
 *  frame instead of its cause. */
export async function runProjectStateWorker(worker: WorkerSelf, init: ProjectStateWorkerInit): Promise<void> {
  let service: Awaited<ReturnType<typeof createWorkerProjectStateService>>
  try {
    await Log.init({ dir: init.directories.projectRoot })
    service = await createWorkerProjectStateService(init)
  } catch (error) {
    init.controlPort.close()
    init.executionPort.close()
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- boundary: Bun Worker.postMessage has no target origin
    worker.postMessage(encodeProjectStateClosed(error))
    return
  }
  const attach = (port: MessagePort, lane: ProjectStateLane) => {
    port.addEventListener("message", (event) => {
      const request = decodeProjectStateRequest(event.data, lane)
      if (!request) return
      let timing = { queueWaitMs: 0, serviceMs: 0 }
      void service.enqueue(lane, request.operation, { bytes: event.data.byteLength, units: operationUnits(request.operation) }, served => { timing = served }).then((served) => {
        const response: ProjectStateResponse = { id: request.id, ...served }
        // One outbound FIFO orders all commit notifications before their acknowledgements.
        try {
          const encodeStartedAt = performance.now()
          const encoded = encodeProjectStateResponse(response)
          const encodeMs = durationMs(encodeStartedAt)
          DebugLog.record({ type: "runtime.state.operation", payload: {
            operation: request.operation.kind === "execution.operation" ? request.operation.operation.kind : request.operation.kind,
            lane, ...timing, encodeMs, responseBytes: encoded.byteLength, outcome: served.result.kind,
          } })
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- boundary: MessagePort.postMessage has no target origin
          init.controlPort.postMessage(encoded, [encoded.buffer])
        } catch (error) {
          throw new Error(`project state ${request.operation.kind} response failed: ${errorMessage(error)}`, { cause: error })
        }
      })
    })
    port.start()
  }
  attach(init.controlPort, "control")
  attach(init.executionPort, "execution")
  worker.addEventListener("message", (event) => {
    if (typeof event.data === "object" && event.data !== null && "flywheel" in event.data && event.data.flywheel === "state.close") {
      void service.close().then(
        () => encodeProjectStateClosed(null),
        (error: unknown) => encodeProjectStateClosed(error),
      ).then(async (closed) => {
        await Log.closeGlobal()
        init.controlPort.close()
        init.executionPort.close()
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- boundary: Bun Worker.postMessage has no target origin
        worker.postMessage(closed)
      })
    }
  })
}

async function createWorkerProjectStateService(init: ProjectStateWorkerInit) {
  const report = (reached: StartupReached): void => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- boundary: MessagePort.postMessage has no target origin
    init.controlPort.postMessage(encodeProjectStateStartupStep(reached))
  }
  let prepared: WorkspaceStatePreparation | undefined
  let runtime: LocalEventStoreRuntime | undefined
  let phase = "workspace preparation"
  try {
    report({ step: "workspace-state" })
    prepared = prepareWorkspaceState(init.directories, report, "project-state")
    phase = "event store runtime"
    report({ step: "event-store" })
    const composition = projectStateComposition({ directories: init.directories, executionCwd: init.executionCwd, predecessorPids: init.predecessorPids })
    runtime = ManagedRuntime.make(EventStoreLive(prepared.dbFile, composition.readSurface))
    // This Worker owns the primary connection, so it serves executors from
    // the synchronous store and hands its own owners the async view of it.
    const store = await runtime.runPromise(LocalEventStoreService)
    const reader: EventStoreReadSurface = store
    const projectionReader = await runtime.runPromise(EventReaderService)
    const writerLane = await runtime.runPromise(EventStoreWriterLaneService)
    const writer = await runtime.runPromise(EventStoreWriterService)
    phase = "session manager"
    report({ step: "sessions" })
    const ownedRuntime = runtime
    const ownedPreparation = prepared
    const owners = composition.open(projectionReader, writer)
    const { gate } = owners
    // A process that opens the store claims what the last process left before
    // anything else writes: a session still marked active whose owner is gone
    // was cut by an unclean exit. The claim reads no history. Each claimed
    // session recovers before its next write and in the background after
    // clients connect, so no start waits for a recovery (ARCH-SUBSTRATE-032).
    phase = "abandoned session recovery"
    report({ step: "interrupted-sessions" })
    gate.owe((await owners.claim("ownerless")).owed)
    writerLane.admitWritesThrough(gate.admission)
    return createProjectStateService({
      reader,
      recover: async (interruptedSessionIds) => { gate.owe((await owners.claim("closed-generation", interruptedSessionIds)).owed) },
      owedRecoveries: gate.owed,
      settleRecovery: gate.settle,
      appendWriteItem: (item) => writerLane.appendWriteItem(item),
      pruneSupersededEvents: (...args) => store.pruneSupersededEvents(...args),
      pruneSupersededKeyedEvents: (...args) => {
        if (!store.pruneSupersededKeyedEvents) throw new Error("event store does not support keyed pruning")
        return store.pruneSupersededKeyedEvents(...args)
      },
      // Each step opens its own handle on this thread. Operations run one at a
      // time here and the writer lane commits synchronously, so the handle
      // never waits on this Worker's own writes. The module loads on the first
      // step, after readiness, so it adds nothing to this Worker's start.
      pruneRetiredFamilyChunk: async (eventType) => (await import("../session/event-store-maintenance.js")).deleteRetiredFamilyChunk(ownedPreparation.dbFile, eventType),
      dropRetiredIndexes: async () => (await import("../session/event-store-maintenance.js")).dropRetiredEventStoreIndexes(ownedPreparation.dbFile).length,
      retireFinalizedCheckpointPage: async (plan) => ({
        kind: "checkpoint-maintenance",
        ...(await import("../migrations/finalized-tool-result-checkpoints.js")).retireRecordedFinalizedToolResultCheckpointPage(ownedPreparation.dbFile, plan.afterRowid, plan),
      }),
      sessions: owners.sessions,
      onStored: store.onStored,
      notifyStored: (events) => {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- boundary: MessagePort.postMessage has no target origin
        init.controlPort.postMessage(encodeProjectStateStored(events))
      },
      notifySessionChange: (change) => {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- boundary: MessagePort.postMessage has no target origin
        init.controlPort.postMessage(encodeProjectStateSessionChange(change))
      },
      close: async () => {
        try {
          const drained = await writerLane.dispose()
          if (drained.kind === "failed") throw new Error(`event-store writer lane drain failed: ${drained.error.message}`)
        } finally {
          try {
            await ownedRuntime.dispose()
          } finally {
            ownedPreparation.generation.release()
          }
        }
      },
    })
  } catch (error) {
    try {
      await runtime?.dispose()
    } finally {
      prepared?.generation.release()
    }
    throw new Error(`project state ${phase} failed: ${errorMessage(error)}`, { cause: error })
  }
}

async function readExactFactSlice(
  reader: AsyncEventStateReadSurface,
  storage: EventStoreReadSurface,
  operation: Extract<ProjectStateOperation, { kind: "facts.slice" }>,
): Promise<ProjectStateResult> {
  if (!boundedProjectStateSlice(operation.query, operation.maxRows, operation.maxBytes)) return { kind: "refused", reason: "invalid" }
  const facts = (await reader.readSlice(operation.query, operation.tolerant)).facts
  const slice: (StoredFact | CorruptEventRowError)[] = []
  let encodedBytes = 0
  for (const fact of facts) {
    const bytes = pack(encodeProjectStateFact(fact)).byteLength
    if (encodedBytes + bytes > operation.maxBytes) {
      if (slice.length === 0) return { kind: "refused", reason: "oversize" }
      return { kind: "refused", reason: "oversize", message: "Exact fact slice exceeds its response budget" }
    }
    slice.push(fact)
    encodedBytes += bytes
  }
  const content = await inlineFactContent(storage, slice, operation.maxRows, operation.maxBytes - encodedBytes)
  return { kind: "fact-slice", facts: slice, contentRows: content.rows, encodedBytes: encodedBytes + content.encodedBytes }
}

async function inlineFactContent(reader: EventStoreReadSurface, facts: readonly (StoredFact | CorruptEventRowError)[], maxRows: number, maxBytes: number) {
  const references = projectStateFactReferences(facts)
  if (references.length === 0) return { rows: [], encodedBytes: 0, complete: true }
  // A single fact can reference more content than one frame holds. Its
  // remaining references use content.page rather than refusing a valid fact.
  if (maxRows === 0 || maxBytes === 0) return { rows: [], encodedBytes: 0, complete: false }
  const content = await readProjectStateContent(reader, { kind: "content.page", references, maxRows, maxBytes })
  if (content.kind === "content") return { rows: content.rows, encodedBytes: content.encodedBytes, complete: content.continuationOffset === null }
  if (content.kind === "refused" && content.reason === "oversize") return { rows: [], encodedBytes: 0, complete: false }
  throw new Error("invalid inline fact content result")
}

async function settleItems(
  items: readonly EventStoreWriteItem[],
  appendWriteItem: (item: EventStoreWriteItem) => Promise<ProjectStateSettlement>,
): Promise<ProjectStateSettlement[]> {
  const settlements: ProjectStateSettlement[] = []
  for (const item of items) {
    try {
      settlements.push(await appendWriteItem(item))
    } catch (error) {
      if (!(error instanceof InFlightSwapConflictError)) throw error
      settlements.push({ kind: "rejected", error })
    }
  }
  return settlements
}

/** The fold evidence that a page asks for. It is read before the page's
 *  facts, so a rewrite between the two shows as a changed generation at the
 *  next evidence read. */
function pageFoldEvidence(reader: Pick<EventStoreReadSurface, "foldEvidence">, query: FactQuery, request: FoldEvidenceRequest | undefined) {
  return request ? { foldEvidence: reader.foldEvidence(query, request.anchorAt) } : {}
}

function generationKey(projectId: string, generation: number): string {
  return `${projectId}:${generation}`
}

function generationRefusal(
  generations: ReadonlyMap<string, number>,
  closed: ReadonlySet<string>,
  projectId: string,
  generation: number,
): ProjectStateResult | undefined {
  if (closed.has(generationKey(projectId, generation))) return { kind: "refused", reason: "closed-generation" }
  if (generations.get(projectId) !== generation) return { kind: "refused", reason: "stale-generation" }
  return undefined
}

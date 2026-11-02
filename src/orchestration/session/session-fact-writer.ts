import type { AsyncEventWriter, EventPayload, EventStoreAppend, GuardedAppendResult, InFlightWrite, StoredFact } from "../../infra/event-store-types.js"
import { requireGuardedEventAppender } from "../../infra/event-store-types.js"
import type { EventStoreDrainResult, EventStoreEnqueueResult, EventStoreWriterLease } from "../../infra/event-store-writer-lane-types.js"
import { Log } from "../../infra/log.js"
import { loggedOperation } from "../../infra/operation-log.js"
import type { ToolContentRow } from "../../infra/tool-content.js"
import type { ModuleSessionFact } from "../module-seams.js"
import type { FileMutationFact } from "./file-mutation-facts.js"
import type { SessionRuntimeFact, ToolContentReferenceFact } from "./session-runtime-event-types.js"
import type { AgentInputFact } from "./agent-input-facts.js"
import type { ProviderRequestAuditFact } from "./provider-request-audit-facts.js"
import { parseSessionFact } from "./session-fact-registry.js"
import type { SessionContentNodeRow } from "../../infra/session-content.js"
import type { ConversationCheckpointFact } from "./conversation-checkpoint-facts.js"
import { durableOwnerAggregate, durableOwnerId, type DurableOwner } from "../../infra/durable-owner.js"

export type SessionFact = SessionRuntimeFact | ToolContentReferenceFact | FileMutationFact | AgentInputFact | ProviderRequestAuditFact | ModuleSessionFact | ConversationCheckpointFact
const log = Log.create({ service: "session-fact-writer" })
const MAX_ENQUEUE_ATTEMPTS = 4

/** Session-scoped sink for validated facts. A lane-backed writer additionally
 *  exposes synchronous enqueue and durability barriers for streaming callers. */
export interface SessionFactWriter {
  /** Stages immutable evidence before settlement. Rejects when disposed or when storage fails. */
  stageSessionContentNodes?(nodes: readonly SessionContentNodeRow[]): Promise<void>
  /** Appends a fact and resolves to its stored event. Resolves `null` without
   *  writing after disposal, or when a transaction queues the fact for its
   *  eventual batch. A lane-backed call retries pressure in order and rejects
   *  on invalid facts, append/commit failure, or exhausted/closed enqueue.
   *  `contentRows` ride the append into the same commit unit (tool output
   *  dedup), so a referencing fact and its bytes land or fail together. */
  record(fact: SessionFact, contentRows?: readonly ToolContentRow[], inFlight?: readonly InFlightWrite[]): Promise<StoredFact | null>
  /** Validates every fact before one atomic append. Publishes only after the
   * whole batch commits; rejects storage failures and nested transaction use.
   * Returns null after disposal, when no facts can be acknowledged. */
  recordBatch(facts: readonly SessionFact[]): Promise<StoredFact[] | null>
  /** Records in-flight recovery state for an operation that has just begun,
   *  with no fact beside it. Its retirement rides the append that records the
   *  outcome (`record`'s `inFlight`), so the two land together. Resolves when
   *  the state is durable; a caller whose contract is record-before-act must
   *  await it and treat a rejection as the operation being refused. */
  putInFlight?(kind: string, key: string, payload: unknown): Promise<void>
  /** Retires in-flight state when an operation has no outcome fact. */
  dropInFlight?(kind: string, key: string): Promise<void>
  /** Guarded transition of one in-flight cell through the shared writer lane. */
  swapInFlight?(kind: string, key: string, expectedRaw: string | null, payload: unknown | null): Promise<boolean>
  /** Appends a fact at exactly `expectedSeq`. A lost race resolves as a typed
   * conflict. Real storage failures still reject. */
  recordGuarded(fact: SessionFact, expectedSeq: number): Promise<GuardedAppendResult | null>
  /** Available only with a writer-lane lease. Makes one synchronous enqueue
   *  attempt; the caller handles pressure/closed results and the commit promise. */
  enqueue?(fact: SessionFact): EventStoreEnqueueResult
  /** Flushes the shared lane queue and joins this writer's accepted publications.
   * Publication failures reject after all accepted publications settle. */
  flush?(): Promise<EventStoreDrainResult>
  /** Available only with a writer-lane lease. Waits for this lease's accepted
   *  events and publications and reports their acknowledgements or failure.
   * Publication failures reject after all accepted publications settle. */
  drain?(): Promise<EventStoreDrainResult>
  /** Runs a synchronous, non-nestable callback whose record calls are committed
   *  in one batch. A callback or append failure rejects and clears the batch;
   *  after disposal this is a no-op. */
  transaction(fn: () => void): Promise<void>
  /** Refuses future work and disposes the lane lease, if present. Does not wait
   *  for previously accepted lane events; use drain first when required. */
  dispose(): void
}

type SessionFactWriterDeps = ({
  readonly sessionId: string
  readonly owner?: never
} | {
  readonly owner: DurableOwner
  readonly sessionId?: never
}) & {
  /** The one append authority. An offline root adapts a local store once with
   *  `asAsyncEventWriter` and passes the result here. */
  readonly writer: Pick<AsyncEventWriter, "append" | "appendBatch" | "putInFlight" | "dropInFlight" | "swapInFlight" | "stageSessionContentNodes">
  readonly lane?: EventStoreWriterLease
  readonly sleep?: (ms: number) => Promise<void>
  /** Projects each committed fact, including transaction and enqueue writes.
   * Runs only after durability, before the write acknowledgement resolves. */
  readonly onStored?: (fact: StoredFact) => void | Promise<void>
}

/** Builds one validated session append for a caller that must atomically
 * compose session evidence with another aggregate. */
export function prepareSessionFactAppend(sessionId: string, fact: SessionFact, contentRows?: readonly ToolContentRow[], inFlight?: readonly InFlightWrite[]): EventStoreAppend {
  const parsed = parseSessionFact<SessionFact>(fact)
  const payload: EventPayload = parsed.payload
  return {
    aggregateId: `session:${sessionId}`,
    type: parsed.type,
    version: parsed.version,
    timestamp: Date.now(),
    actor: parsed.actor,
    sessionId,
    payload,
    ...(contentRows !== undefined && contentRows.length > 0 ? { contentRows } : {}),
    ...(inFlight !== undefined && inFlight.length > 0 ? { inFlight } : {}),
  }
}

export function createSessionFactWriter(deps: SessionFactWriterDeps): SessionFactWriter {
  const { lane, writer: eventWriter } = deps
  const owner: DurableOwner = deps.owner ?? { kind: "session", sessionId: deps.sessionId }
  const sessionId = durableOwnerId(owner)
  const prepare = (fact: SessionFact, contentRows?: readonly ToolContentRow[], inFlight?: readonly InFlightWrite[]): EventStoreAppend => ({
    ...prepareSessionFactAppend(sessionId, fact, contentRows, inFlight),
    aggregateId: durableOwnerAggregate(owner),
  })
  const stageNodes = eventWriter.stageSessionContentNodes?.bind(eventWriter)
  const sleep = deps.sleep ?? Bun.sleep
  let disposed = false

  let batch: EventStoreAppend[] | null = null
  // Set while a pressured record sleeps; later records wait on it so a
  // pressured fact is never overtaken. Accepted enqueues stay synchronous at
  // record() call time, preserving order against the direct enqueue() path
  // and letting the lane batch concurrent commits.
  let pressureGate: Promise<void> | null = null
  // Lane barriers know only durability. Retain publication acknowledgements
  // until the next barrier consumes them, including failures from abandoned enqueues.
  const publications = new Set<Promise<void>>()
  function publishAccepted(result: Extract<EventStoreEnqueueResult, { kind: "accepted" }>): Promise<StoredFact> {
    // Storage failures remain the lane's responsibility; only projection
    // failures extend its durability barrier.
    const publication = result.commit.then(
      async (stored) => { await deps.onStored?.(stored) },
      () => {},
    )
    publications.add(publication)
    publication.catch(() => {})
    const commit = result.commit.then(async (stored) => {
      await publication
      return stored
    })
    commit.catch(() => {})
    return commit
  }

  async function barrier(lease: EventStoreWriterLease, drain: boolean): Promise<EventStoreDrainResult> {
    const accepted = [...publications]
    const result = await (drain ? lease.drain() : lease.flush())
    const settled = await Promise.allSettled(accepted)
    for (const publication of accepted) publications.delete(publication)
    const failed = settled.find((item) => item.status === "rejected")
    if (result.kind === "drained" && failed?.status === "rejected") throw failed.reason
    return result
  }
  async function enqueueWithRetry(lease: EventStoreWriterLease, event: EventStoreAppend): Promise<StoredFact | null> {
    // Reads the gate each pass: an awaited gate can be replaced by another
    // pressured record before this one resumes.
    for (let gate = pressureGate; gate !== null; gate = pressureGate) await gate
    for (let attempt = 1; attempt <= MAX_ENQUEUE_ATTEMPTS; attempt += 1) {
      // Dispose during a gate or retry sleep: drop quietly like any other
      // post-dispose record instead of enqueueing into the disposed lease.
      if (disposed) return null
      const enqueued = lease.enqueue(event)
      if (enqueued.kind === "accepted") {
        log.debug("record fact enqueued", { sessionId, eventType: event.type, queuedEvents: enqueued.queuedEvents, queuedBytes: enqueued.queuedBytes, attempt })
        // The commit promise rejects with the real error (seq conflicts
        // included); the awaiting caller decides what a failure means.
        return await publishAccepted(enqueued)
      }
      if (enqueued.kind !== "pressure" || attempt === MAX_ENQUEUE_ATTEMPTS) {
        throw new Error(`session event writer enqueue failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${enqueued.kind}${"reason" in enqueued ? ` (${enqueued.reason})` : ""}`)
      }
      const gate = sleep(enqueued.retryAfterMs)
      pressureGate = gate
      try {
        await gate
      } finally {
        if (pressureGate === gate) pressureGate = null
      }
    }
    throw new Error("session event writer enqueue attempts exhausted")
  }

  async function record(fact: SessionFact, contentRows?: readonly ToolContentRow[], inFlight?: readonly InFlightWrite[]): Promise<StoredFact | null> {
    if (disposed) return null
    const event = prepare(fact, contentRows, inFlight)
    const fields = { sessionId, eventType: event.type, lane: lane ? "yes" : "no", batched: batch !== null }
    // Write path: one record per fact duplicates what the durable store already
    // holds. `events search` reads the fact itself, so the log record earns DEBUG.
    if (batch) {
      batch.push(event)
      return loggedOperation({ log, operation: "record fact", level: "debug", fields, summarize: recordSummary }, async () => null)
    }
    const stored = await loggedOperation({ log, operation: "record fact", level: "debug", fields, summarize: recordSummary },
      () => lane ? enqueueWithRetry(lane, event) : eventWriter.append(event))
    if (stored && !lane) await deps.onStored?.(stored)
    return stored
  }

  async function recordGuarded(fact: SessionFact, expectedSeq: number): Promise<GuardedAppendResult | null> {
    if (disposed) return null
    if (batch) throw new Error("SessionFactWriter.recordGuarded cannot join a transaction batch")
    const event = { ...prepare(fact), expectedSeq }
    const fields = { sessionId, eventType: event.type, expectedSeq }
    const operation = loggedOperation({
      log,
      operation: "record guarded fact",
      fields,
      summarize: (outcome) => outcome.kind === "conflict"
        ? { kind: outcome.kind, actualSeq: outcome.conflict.actualSeq }
        : { kind: outcome.kind, position: outcome.events[0]?.position },
    }, () => requireGuardedEventAppender(eventWriter, "SessionFactWriter.recordGuarded requires guarded append authority").appendGuarded(event))
      .then(async (result) => {
        if (result.kind === "stored") {
          for (const stored of result.events) await deps.onStored?.(stored)
        }
        return result
      })
    const publication = operation.then(() => {})
    publications.add(publication)
    publication.catch(() => {})
    return await operation
  }

  async function recordBatch(facts: readonly SessionFact[]): Promise<StoredFact[] | null> {
    if (disposed) return null
    if (batch) throw new Error("SessionFactWriter.recordBatch cannot join a transaction batch")
    const events = facts.map((fact) => prepare(fact))
    const stored = await eventWriter.appendBatch(events)
    for (const fact of stored) await deps.onStored?.(fact)
    return stored
  }

  async function transaction(fn: () => void): Promise<void> {
    if (disposed) return
    return loggedOperation({ log, operation: "transaction", level: "debug", fields: { sessionId }, summarize: () => ({}) }, async () => {
      if (batch) throw new Error("SessionFactWriter.transaction does not support nesting")
      batch = []
      try {
        const result: unknown = fn()
        if (typeof result === "object" && result !== null && "then" in result && typeof result.then === "function") {
          throw new Error("SessionFactWriter.transaction callback must be synchronous")
        }
        const events = batch
        batch = null
        log.debug("transaction append batch", { sessionId, events: events.length, factTypes: [...new Set(events.map((event) => event.type))].slice(0, 12) })
        if (events.length > 0) {
          const stored = await eventWriter.appendBatch(events)
          for (const fact of stored) await deps.onStored?.(fact)
        }
      } catch (err) {
        batch = null
        throw err
      }
    })
  }

  function dispose(): void {
    disposed = true
    log.debug("dispose", { sessionId, lane: lane ? "yes" : "no" })
    lane?.dispose()
  }

  /** Offered only when the store can hold it: a read-only or double store has
   *  no in-flight state, and a caller that needs it says so rather than
   *  silently recording nothing. The rejection propagates: a preparation that
   *  could not be stored (disk full, closed store) must stop the operation it
   *  guards instead of letting it run unrecoverable. */
  async function putInFlight(kind: string, key: string, payload: unknown): Promise<void> {
    await eventWriter.putInFlight?.(sessionId, kind, key, payload)
  }

  async function dropInFlight(kind: string, key: string): Promise<void> {
    await eventWriter.dropInFlight?.(sessionId, kind, key)
  }

  async function swapInFlight(kind: string, key: string, expectedRaw: string | null, payload: unknown | null): Promise<boolean> {
    return await eventWriter.swapInFlight?.(sessionId, kind, key, expectedRaw, payload) ?? false
  }

  const writer: SessionFactWriter = {
    record,
    recordBatch,
    recordGuarded,
    transaction,
    dispose,
    ...(eventWriter.putInFlight ? { putInFlight } : {}),
    ...(eventWriter.dropInFlight ? { dropInFlight } : {}),
    ...(eventWriter.swapInFlight ? { swapInFlight } : {}),
    ...(stageNodes ? {
      async stageSessionContentNodes(nodes: readonly SessionContentNodeRow[]) {
        if (disposed) throw new Error("session event writer disposed")
        await stageNodes(sessionId, nodes)
      },
    } : {}),
  }
  if (!lane) return writer

  return {
    ...writer,
    enqueue(fact) {
      if (disposed) return { kind: "closed", state: "disposed", scope: "lease", message: "session event writer disposed" }
      const event = prepare(fact)
      const result = lane.enqueue(event)
      // Debug, not info: enqueue runs per stream event, so at INFO this floods
      // the log and burns worker-runtime time formatting lines during streaming.
      log.debug("enqueue fact", { sessionId, eventType: event.type, kind: result.kind, queuedEvents: "queuedEvents" in result ? result.queuedEvents : undefined, queuedBytes: "queuedBytes" in result ? result.queuedBytes : undefined, reason: "reason" in result ? result.reason : undefined })
      if (result.kind !== "accepted") return result
      const commit = publishAccepted(result)
      return {
        ...result,
        ticket: { ...result.ticket, commit },
        commit,
      }
    },
    flush() {
      // Per turn, so DEBUG: the writer lane owns the durability evidence, and
      // a failed barrier still records at ERROR.
      return loggedOperation({ log, operation: "flush", level: "debug", fields: { sessionId }, summarize: drainSummary }, () => barrier(lane, false))
    },
    drain() {
      return loggedOperation({ log, operation: "drain", level: "debug", fields: { sessionId }, summarize: drainSummary }, () => barrier(lane, true))
    },
  }
}

function recordSummary(event: StoredFact | null): StringMap<unknown> {
  return event ? { position: event.position, seq: event.seq } : { deferred: true }
}

function drainSummary(result: EventStoreDrainResult): StringMap<unknown> {
  return { kind: result.kind, acked: result.acked.length }
}
interface StringMap<T> { [key: string]: T }

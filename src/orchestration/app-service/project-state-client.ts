import { trackLoopSpan } from "../../infra/event-loop-lag.js"
import {
  CorruptEventRowError,
  StateRequestNotServedError,
  type AsyncEventStateReadSurface,
  type AsyncGuardedEventWriter,
  type EventStoreAppend,
  type EventStoreItemSettlement,
  type FactQuery,
  type GuardedAppendResult,
  type EventStoreWriteItem,
  type GuardedEventStoreAppend,
  storedFact,
  type StoredFact,
} from "../../infra/event-store-types.js"
import { InvariantViolation } from "../../infra/invariant.js"
import { Log } from "../../infra/log.js"
import { errorMessage } from "../../infra/error-message.js"
import type { ContentResolver } from "../../infra/tool-content.js"
import { storedToolContentReferences } from "../../infra/tool-content-hydration.js"
import type { SessionMetadataChange } from "../session/manager.js"
import { createProjectStateSessionManager, type ProjectStateSessionManager } from "./project-state-sessions.js"
import { createProjectStateCommitWindow } from "./project-state-commit-window.js"
import { createProjectStateFreshness } from "./project-state-freshness.js"
import { recoveryOwnersOf } from "./session-recovery-gate.js"
import {
  decodeProjectStateResponse,
  validateProjectStateRequest,
  PROJECT_STATE_MAX_BYTES,
  PROJECT_STATE_MAX_QUEUED_ITEMS,
  PROJECT_STATE_MAX_PAGE_ROWS,
  operationUnits,
  encodeProjectStateRequest,
  encodeProjectStateResponse,
  readdressProjectStateResponse,
  type ProjectStateContentReference,
  type ProjectStateContentRow,
  type ProjectStateControlOperation,
  type ProjectStateExecutionOperation,
  type ProjectStateLane,
  type ProjectStateRequest,
  type ProjectStateResponseFrame,
  type ProjectStateResult,
  type ProjectStateServed,
  type ProjectStateSettlement,
} from "./project-state-protocol.js"

/** The state Worker is gone or broke its protocol, so no request reaches it.
 *  `cause` is the Worker's own failure when it reported one. */
export class ProjectStateUnavailableError extends StateRequestNotServedError {
  override readonly name = "ProjectStateUnavailableError"
  constructor(readonly reason: string, cause?: Error) {
    super(`project state is unavailable: ${reason}`, cause === undefined ? undefined : { cause })
  }
}

export interface ProjectStateClientTransport {
  prepare?(request: ProjectStateRequest): ProjectStateRequest
  send(request: ProjectStateRequest, encoded: Uint8Array): void
  /** Delivers each response with its body unread. The listener answers
   *  false for a response it cannot read, and the transport then closes as it
   *  does for any other invalid message. */
  onResponse(listener: (frame: ProjectStateResponseFrame) => boolean): void
  onClose(listener: (reason: string, cause?: Error) => void): void
  onSessionChange(listener: (change: SessionMetadataChange) => void): () => void
  onStored(listener: (events: readonly StoredFact[]) => void): () => void
  /** The transport was lost and may come back: broadcasts sent meanwhile
   *  can be missing. */
  onDetach?(listener: () => void): void
  close(): void | Promise<void>
}

/** The store upkeep startup maintenance asks of the sole writer (ARCH-SUBSTRATE-018, ARCH-SUBSTRATE-026),
 *  one bounded step per call. */
interface ProjectStateUpkeep {
  /** Deletes one chunk of one retired family; answers the rows deleted. */
  pruneRetiredFamilyChunk(eventType: string): Promise<number>
  /** Drops the indexes the schema retired; answers how many it dropped. */
  dropRetiredIndexes(): Promise<number>
  /** Rechecks and retires one page of fully recorded finalized results. */
  retireFinalizedCheckpointPage(plan: Omit<Extract<ProjectStateControlOperation, { kind: "maintenance.finalized-checkpoints" }>, "kind">): Promise<Extract<ProjectStateResult, { kind: "checkpoint-maintenance" }>>
}

export interface ProjectStateClient extends AsyncEventStateReadSurface {
  readonly available: boolean
  readonly sessions: ProjectStateSessionManager
  readonly writer: AsyncGuardedEventWriter
  readonly upkeep: ProjectStateUpkeep
  onStored(listener: (events: readonly StoredFact[]) => void): () => void
  control(operation: ProjectStateControlOperation): Promise<ProjectStateResult>
  execution(operation: ProjectStateExecutionOperation): Promise<ProjectStateResult>
  /** Sends one request on `lane` and answers the response frame for the
   *  peer's request `id`: the state Worker's frame, head included, readdressed
   *  with its body unread, or a frame of the answer this client gave itself,
   *  such as a refusal for pressure. The peer reads and validates the body.
   *  Fails as `control` and `execution` do. */
  relay(lane: ProjectStateLane, operation: ProjectStateControlOperation | ProjectStateExecutionOperation, id: number): Promise<Uint8Array>
  close(): Promise<void>
}

interface PendingRequest {
  readonly lane: ProjectStateLane
  readonly bytes: number
  readonly units: number
  readonly capture: boolean
  readonly resolve: (served: ProjectStateServed) => void
  /** Set for a relay, which takes the state Worker's frame unread. */
  readonly relay: ((frame: ProjectStateResponseFrame) => void) | undefined
  readonly reject: (error: ProjectStateUnavailableError) => void
}

const CAPTURE: ProjectStateControlOperation = { kind: "position.capture" }

/** `commitWindow` answers reads of recent history from the commit broadcast
 *  (see `ProjectStateCommitWindow`) and serves position barriers from the
 *  heads of responses (see `ProjectStateFreshness`). Only a client that hears
 *  every broadcast of its store connection, as an executor's does, can use it. */
export function createProjectStateClient(
  transport: ProjectStateClientTransport,
  options: { readonly maxQueuedItems?: number; readonly maxQueuedBytes?: number; readonly commitWindow?: boolean } = {},
): ProjectStateClient {
  const maxQueuedItems = options.maxQueuedItems ?? PROJECT_STATE_MAX_QUEUED_ITEMS
  const maxQueuedBytes = options.maxQueuedBytes ?? PROJECT_STATE_MAX_BYTES
  const pending = new Map<number, PendingRequest>()
  const totals = { control: { items: 0, bytes: 0 }, execution: { items: 0, bytes: 0 } }
  let nextId = 1
  let available = true
  let closing: Promise<void> | undefined
  let idle: (() => void) | undefined
  const sessionListeners = new Set<(change: SessionMetadataChange) => void>()
  const storedListeners = new Set<(events: readonly StoredFact[]) => void>()
  const commitWindow = options.commitWindow ? createProjectStateCommitWindow() : undefined
  const freshness = commitWindow ? createProjectStateFreshness({
    nextId: () => nextId,
    anyPending: () => pending.size > 0,
    pending: (id) => pending.has(id),
  }, requestCapture) : undefined
  transport.onDetach?.(() => commitWindow?.unanchor())
  const stopStored = transport.onStored((events) => {
    // Before any listener, so a read that a listener starts already sees them.
    commitWindow?.receive(events)
    for (const listener of storedListeners) {
      try {
        listener(events)
      } catch (error) {
        Log.create({ service: "project-state-client" }).error("onStored listener failed", { error: errorMessage(error) })
      }
    }
  })
  const stopSessionChanges = transport.onSessionChange((change) => {
    if (available) for (const listener of sessionListeners) listener(change)
  })
  const sessions = createProjectStateSessionManager({
    async request(command) {
      const result = await request("control", { kind: "session.control", command })
      if (result.kind === "session-result") return result.result
      throw stateReadError(result)
    },
    subscribe(listener) {
      sessionListeners.add(listener)
      return () => sessionListeners.delete(listener)
    },
  })
  const writer: AsyncGuardedEventWriter = {
    async append(event) {
      const events = requireStored(await appendSettlement("append", [event]))
      const stored = events[0]
      if (!stored || events.length !== 1) throw new ProjectStateUnavailableError("append returned an invalid stored settlement")
      return stored
    },
    appendBatch(events) {
      if (events.length === 0) return Promise.resolve([])
      return appendSettlement("append.batch", events).then(requireStored)
    },
    appendGuarded(event) {
      return appendSettlement("append", [event]).then(guardedResult)
    },
    appendBatchGuarded(events) {
      if (events.length === 0) return Promise.resolve({ kind: "stored", events: [] })
      return appendSettlement("append.batch", events).then(guardedResult)
    },
    async stageSessionContentNodes(sessionId, nodes) {
      const result = await request("control", { kind: "content.stage", sessionId, nodes })
      if (result.kind !== "ok") {
        if (result.kind === "failed") throw result.error
        throw stateReadError(result)
      }
    },
    async pruneSupersededEvents(aggregateId, eventType) {
      return maintenance({ kind: "maintenance.prune", aggregateId, eventType })
    },
    async pruneSupersededKeyedEvents(aggregateId, eventType, payloadKey) {
      return maintenance({ kind: "maintenance.prune-keyed", aggregateId, eventType, payloadKey })
    },
  }

  async function appendSettlement(
    kind: "append" | "append.batch",
    events: readonly (EventStoreAppend | GuardedEventStoreAppend)[],
  ): Promise<EventStoreItemSettlement> {
    const first = events[0]
    if (!first) throw new ProjectStateUnavailableError("append requires at least one event")
    const item = { sessionId: first.sessionId, events }
    const result = await request("control", kind === "append" ? { kind, item } : { kind, items: [item] })
    if (result.kind !== "stored") throw stateWriteError(result, "stored")
    const settlement = result.settlements[0]
    if (!settlement || result.settlements.length !== 1) throw new ProjectStateUnavailableError("append returned an invalid settlement count")
    return storedSettlement(item, settlement)
  }

  async function maintenance(operation: Extract<ProjectStateControlOperation, { kind: `maintenance.${string}` }>): Promise<number> {
    const result = await request("control", operation)
    if (result.kind !== "maintenance") throw stateWriteError(result, "maintenance")
    return result.affected
  }

  transport.onResponse((frame) => {
    const pendingRequest = pending.get(frame.id)
    if (!pendingRequest) return true
    if (pendingRequest.relay) {
      settle(frame.id, pendingRequest, undefined)
      pendingRequest.relay(frame)
    } else {
      const response = decodeProjectStateResponse(frame.bytes)
      if (!response) return false
      settle(frame.id, pendingRequest, response)
      pendingRequest.resolve(response)
    }
    if (pending.size === 0) idle?.()
    return true
  })

  /** Releases an answered request's admission. A relayed answer is unread,
   *  so it gives the window no head, as an answer without one does. */
  function settle(id: number, pendingRequest: PendingRequest, served: ProjectStateServed | undefined): void {
    pending.delete(id)
    totals[pendingRequest.lane].items -= pendingRequest.units
    totals[pendingRequest.lane].bytes -= pendingRequest.bytes
    // Before the requester resumes, so a read it starts next sees the window
    // anchored at the head.
    if (commitWindow && freshness) {
      const head = served?.head
      const result = served?.result
      if (head !== undefined) commitWindow.observe(head)
      if (pendingRequest.capture && result?.kind === "position") commitWindow.observe(result.position)
      const capture = !pendingRequest.capture || !result ? undefined : result.kind === "position" ? result.position : stateReadError(result)
      freshness.answered(id, head, capture)
    }
  }
  transport.onClose((reason, cause) => {
    available = false
    // A closed transport never comes back, so the window answers nothing more.
    commitWindow?.close()
    const error = new ProjectStateUnavailableError(reason, cause)
    for (const pendingRequest of pending.values()) pendingRequest.reject(error)
    pending.clear()
    freshness?.end(error)
    idle?.()
  })

  function request(lane: ProjectStateLane, operation: ProjectStateControlOperation | ProjectStateExecutionOperation): Promise<ProjectStateResult> {
    return dispatch(lane, operation, (served) => served.result)
  }

  /** Sends one request and answers `answer` of what was served, in the one
   *  promise the caller holds. With `unread`, the state Worker's response
   *  reaches it unread instead; answers this client gives itself still go
   *  through `answer`. */
  function dispatch<T>(
    lane: ProjectStateLane,
    operation: ProjectStateControlOperation | ProjectStateExecutionOperation,
    answer: (served: ProjectStateServed) => T,
    unread?: (frame: ProjectStateResponseFrame) => T,
  ): Promise<T> {
    if (!available) return Promise.reject(new ProjectStateUnavailableError("worker closed"))
    const outbound = transport.prepare?.({ id: nextId, lane, operation }) ?? { id: nextId, lane, operation }
    try {
      validateProjectStateRequest(outbound, outbound.lane)
    } catch (error) {
      return Promise.resolve(answer({ result: { kind: "refused", reason: "invalid", message: errorMessage(error) } }))
    }
    let encoded: Uint8Array
    try {
      encoded = encodeProjectStateRequest(outbound, Math.min(PROJECT_STATE_MAX_BYTES, maxQueuedBytes))
    } catch (error) {
      return Promise.reject(error)
    }
    const admission = { bytes: encoded.byteLength, units: operationUnits(operation) }
    const total = totals[outbound.lane]
    if (total.items + admission.units > maxQueuedItems || total.bytes + admission.bytes > maxQueuedBytes) {
      return Promise.resolve(answer({ result: { kind: "refused", reason: "pressure" } }))
    }
    const id = nextId++
    const kind = operation.kind === "execution.operation" ? operation.operation.kind : operation.kind
    const end = trackLoopSpan("project-state", `${outbound.lane}:${kind}`)
    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        ...admission, lane: outbound.lane, capture: operation === CAPTURE,
        resolve: (served) => { end(); holdAppendedContent(operation, served.result); resolve(answer(served)) },
        relay: unread && ((frame) => { end(); resolve(unread(frame)) }),
        reject: (error) => { end(); reject(error) },
      })
      total.items += admission.units
      total.bytes += admission.bytes
      try {
        transport.send(outbound, encoded)
        if (outbound.lane === "control") freshness?.sentControl(id)
      } catch (error) {
        pending.delete(id)
        total.items -= admission.units
        total.bytes -= admission.bytes
        end()
        reject(new ProjectStateUnavailableError(error instanceof Error ? error.message : String(error)))
        if (pending.size === 0) idle?.()
      }
    })
  }

  /** Holds the content rows of a stored append beside its facts in the
   *  window, before any caller sees the acknowledgement, so a local read of
   *  the facts hydrates them without a content request. Every append path of
   *  the client (its writer and raw `control` or `execution` appends) settles
   *  here. */
  function holdAppendedContent(operation: ProjectStateControlOperation | ProjectStateExecutionOperation, result: ProjectStateResult): void {
    if (!commitWindow || result.kind !== "stored") return
    const appended = operation.kind === "execution.operation" ? operation.operation : operation
    const items = appended.kind === "append" ? [appended.item] : appended.kind === "append.batch" ? appended.items : []
    for (const [index, item] of items.entries()) {
      const settlement = result.settlements[index]
      // A receipt count that differs from the events sent fails the append in `storedSettlement`.
      if (settlement?.kind !== "stored" || settlement.receipts.length !== item.events.length) continue
      for (const [eventIndex, receipt] of settlement.receipts.entries()) {
        const rows = item.events[eventIndex]?.contentRows
        if (rows?.length) commitWindow.holdContent(receipt.position, rows)
      }
    }
  }

  async function requestCapture(): Promise<number> {
    const result = await request("control", CAPTURE)
    if (result.kind !== "position") throw stateReadError(result)
    return result.position
  }

  const capturePosition = freshness
    ? () => available ? freshness.barrier() : Promise.reject(new ProjectStateUnavailableError("worker closed"))
    : requestCapture

  const readPage: ProjectStateClient["readPage"] = async (query, upperPosition, afterPosition, tolerant, requestedContent, evidence) => {
    const content = requestedContent ?? "eager"
    let upper = upperPosition
    // Only the store holds fold evidence, so a page that asks for it never
    // comes from the window. Only a read the window could answer pays for
    // the barrier; any other read lets the state Worker capture its ceiling
    // in the same request.
    const windowed = evidence === undefined ? commitWindow : undefined
    if (upper === undefined && windowed?.mayAnswerPage(query, afterPosition)) upper = await capturePosition()
    const local = upper === undefined ? undefined : windowed?.page(query, upper, afterPosition)
    if (upper !== undefined && local) {
      return { ...local, upperPosition: upper, toolContent: await hydrateFacts(content === "eager" ? local.facts : []) }
    }
    const result = await request("control", { kind: "facts.page", query, upperPosition: upper, afterPosition, tolerant: tolerant ?? false, content,
      maxRows: PROJECT_STATE_MAX_PAGE_ROWS, maxBytes: PROJECT_STATE_MAX_BYTES, ...(evidence ? { evidence } : {}) })
    if (result.kind !== "facts") throw stateReadError(result)
    return {
      facts: result.facts, upperPosition: result.upperPosition, continuationPosition: result.continuationPosition,
      toolContent: await hydrateFacts(content === "eager" ? result.facts : [], result.contentRows),
      ...(result.foldEvidence ? { foldEvidence: result.foldEvidence } : {}),
    }
  }

  async function readCapturedSlice(query: FactQuery, tolerant: boolean) {
    let upperPosition: number | undefined
    const facts: (StoredFact | CorruptEventRowError)[] = []
    const resolvers: ContentResolver[] = []
    let afterPosition = query.afterPosition ?? 0
    for (;;) {
      const page = await readPage(query, upperPosition, afterPosition, tolerant)
      upperPosition = page.upperPosition
      facts.push(...page.facts)
      resolvers.push(page.toolContent)
      if (page.continuationPosition === null) break
      afterPosition = page.continuationPosition
    }
    if (query.order === "desc") facts.reverse()
    return { facts, toolContent: { resolve: (sessionId: string, sha256: string) => resolvers.reduce<string | null>((found, resolver) => found ?? resolver.resolve(sessionId, sha256), null) } }
  }

  async function hydrateFacts(facts: readonly (StoredFact | CorruptEventRowError)[], rows: readonly ProjectStateContentRow[] = []) {
    const content = new Map<string, string | InvariantViolation>()
    function retain(row: ProjectStateContentRow) {
      const key = `${row.reference.sessionId}\0${row.reference.reference.sha256}`
      // Bytes stay unproven until the hydration seam uses them.
      if ("error" in row) { if (!content.has(key)) content.set(key, row.error) }
      else content.set(key, row.content)
    }
    for (const row of rows) retain(row)
    const references: ProjectStateContentReference[] = []
    for (const fact of facts) {
      if (fact instanceof CorruptEventRowError || !fact.sessionId) continue
      let held: { readonly [sha256: string]: string } | undefined
      for (const reference of storedToolContentReferences(fact)) {
        const key = `${fact.sessionId}\0${reference.sha256}`
        if (content.has(key)) continue
        held ??= commitWindow?.contentOf(fact.position) ?? {}
        const local = held[reference.sha256]
        if (local !== undefined) content.set(key, local)
        else references.push({ sessionId: fact.sessionId, reference, fact: { eventType: fact.type, eventPosition: fact.position, aggregateId: fact.aggregateId } })
      }
    }
    // Pages of whole blobs bound each transfer: a page ends before the blob
    // that would pass its byte budget, and the next page starts at that blob.
    // A page per reference made a large history's open one round trip per
    // tool result, each queued behind every other state read.
    let offset = 0
    while (offset < references.length) {
      const page = await request("control", { kind: "content.page", references, offset, maxRows: PROJECT_STATE_MAX_PAGE_ROWS, maxBytes: PROJECT_STATE_MAX_BYTES })
      if (page.kind !== "content") throw stateReadError(page)
      if (page.rows.length === 0) throw new ProjectStateUnavailableError("incomplete content response")
      for (const row of page.rows) retain(row)
      const next = page.continuationOffset
      if (next === null) break
      if (next <= offset) throw new ProjectStateUnavailableError("content response did not advance")
      offset = next
    }
    return { resolve(sessionId: string, sha256: string) {
      const value = content.get(`${sessionId}\0${sha256}`)
      if (value instanceof InvariantViolation) throw value
      return value ?? null
    } }
  }

  const client: ProjectStateClient = {
    get available() {
      return available
    },
    sessions,
    writer,
    upkeep: {
      pruneRetiredFamilyChunk: (eventType) => maintenance({ kind: "maintenance.prune-retired", eventType }),
      dropRetiredIndexes: () => maintenance({ kind: "maintenance.drop-retired-indexes" }),
      async retireFinalizedCheckpointPage(plan) {
        const result = await request("control", { kind: "maintenance.finalized-checkpoints", ...plan })
        if (result.kind !== "checkpoint-maintenance") throw stateReadError(result)
        return result
      },
    },
    onStored(listener) {
      storedListeners.add(listener)
      return () => { storedListeners.delete(listener) }
    },
    control: (operation) => request("control", operation),
    execution: (operation) => request("execution", operation),
    relay: (lane, operation, id) => dispatch(lane, operation,
      (served) => encodeProjectStateResponse({ id, ...served }),
      (frame) => readdressProjectStateResponse(frame, id)),
    capturePosition,
    async latestPosition(type) {
      const result = await request("control", { kind: "facts.latest-position", type })
      if (result.kind !== "position") throw stateReadError(result)
      return result.position
    },
    async readLatestPayloadByAggregateAndType(aggregateId, type) {
      const result = await request("control", { kind: "facts.latest-payload", aggregateId, type })
      if (result.kind !== "latest-payload") throw stateReadError(result)
      return result.payload
    },
    async readLatestByAggregateAndTypes(aggregateId, types) {
      const result = await request("control", { kind: "facts.latest-by-types", aggregateId, types })
      if (result.kind !== "fact-list") throw stateReadError(result)
      return [...result.facts]
    },
    async readInFlight(sessionId, kind, keyPrefix) {
      const result = await request("control", { kind: "in-flight.read", sessionId, kinds: typeof kind === "string" ? [kind] : kind, ...(keyPrefix === undefined ? {} : { keyPrefix }) })
      if (result.kind !== "in-flight") throw stateReadError(result)
      return [...result.records]
    },
    async sessionsWithInFlight(kind) {
      const result = await request("control", { kind: "in-flight.sessions", inFlightKind: kind })
      if (result.kind !== "session-ids") throw stateReadError(result)
      return [...result.sessionIds]
    },
    async hasInFlightProfile(kind, profileId) {
      const result = await request("control", { kind: "in-flight.profile", inFlightKind: kind, profileId })
      if (result.kind !== "in-flight.profile") throw stateReadError(result)
      return result.found
    },
    async countByAggregate(aggregateId) {
      const result = await request("control", { kind: "aggregate.count", aggregateId })
      if (result.kind !== "count") throw stateReadError(result)
      return result.count
    },
    async aggregateSeq(aggregateId) {
      // A session or workflow sequence goes to the state Worker, which first
      // settles the recovery that sequence may owe (`settlingGuardReads`).
      if (recoveryOwnersOf(aggregateId).length === 0 && commitWindow?.sequence(aggregateId) !== undefined) {
        await capturePosition()
        const local = commitWindow.sequence(aggregateId)
        if (local !== undefined) return local
      }
      const result = await request("control", { kind: "aggregate.sequence", aggregateId })
      if (result.kind !== "sequence") throw stateReadError(result)
      return result.sequence
    },
    contentFor: hydrateFacts,
    async readSessionContentNode(sessionId, sha256) {
      const result = await request("control", { kind: "content.node", sessionId, sha256, maxBytes: PROJECT_STATE_MAX_BYTES })
      if (result.kind !== "content.node") throw stateReadError(result)
      if (result.value.kind === "available") return result.value.node
      return result.value.reason === "missing" ? null : result.value
    },
    async readSessionContentRange(sessionId, reference, offset, length) {
      const result = await request("control", { kind: "content.range", sessionId, reference, offset, length, maxBytes: PROJECT_STATE_MAX_BYTES })
      if (result.kind !== "content.range") throw stateReadError(result)
      return result.range
    },
    async readSlice(query, tolerant = false) {
      // The state Worker answers only bounded probes, so a query that names
      // no limit or positions reads its pages through one captured position.
      if (query.limit === undefined && query.positions === undefined) return readCapturedSlice(query, tolerant)
      if (commitWindow?.maySlice(query)) {
        const local = commitWindow.slice(query, await capturePosition())
        if (local) return { facts: local, toolContent: await hydrateFacts(local) }
      }
      const result = await request("control", {
        kind: "facts.slice", query, tolerant,
        maxRows: PROJECT_STATE_MAX_PAGE_ROWS, maxBytes: PROJECT_STATE_MAX_BYTES,
      })
      if (result.kind !== "fact-slice") throw stateReadError(result)
      return { facts: result.facts, toolContent: await hydrateFacts(result.facts, result.contentRows) }
    },
    readPage,
    close() {
      if (closing) return closing
      available = false
      commitWindow?.close()
      freshness?.end(new ProjectStateUnavailableError("worker closed"))
      stopSessionChanges()
      sessionListeners.clear()
      const drained = pending.size === 0 ? Promise.resolve() : new Promise<void>((resolve) => { idle = resolve })
      closing = drained.then(() => {
        stopStored()
        storedListeners.clear()
        return transport.close()
      })
      return closing
    },
  }
  return client
}

/** The state Worker answered a request with a refusal instead of a result. */
export class ProjectStateRefusedError extends StateRequestNotServedError {
  override readonly name = "ProjectStateRefusedError"
  constructor(readonly reason: Extract<ProjectStateResult, { kind: "refused" }>["reason"], message?: string) {
    super(message ?? `project state request refused: ${reason}`)
  }
}

function stateReadError(result: ProjectStateResult): Error {
  if (result.kind === "failed") return result.error
  if (result.kind === "refused") return new ProjectStateRefusedError(result.reason, result.message)
  return new ProjectStateUnavailableError(`unexpected read response: ${result.kind}`)
}

function stateWriteError(result: ProjectStateResult, expected: "stored" | "maintenance"): Error {
  if (result.kind === "failed") return result.error
  if (result.kind === "refused") return new ProjectStateRefusedError(result.reason, result.message)
  return new ProjectStateUnavailableError(`unexpected write response: expected ${expected}, received ${result.kind}`)
}

/** Completes an append item's acknowledgement into the facts the store holds:
 *  each receipt names what the store assigned to the event the appender sent
 *  at its index, unless the receipt is the whole fact. Throws when the
 *  acknowledgement does not name exactly one receipt per sent event. */
export function storedSettlement(item: EventStoreWriteItem, settlement: ProjectStateSettlement): EventStoreItemSettlement {
  if (settlement.kind !== "stored") return settlement
  if (settlement.receipts.length !== item.events.length) throw new ProjectStateUnavailableError("append acknowledged a different number of facts than it sent")
  return { kind: "stored", events: settlement.receipts.map((receipt, index) => {
    if ("payload" in receipt) return receipt
    // SAFETY: the length check above proved one sent event per receipt index.
    const event = item.events[index]!
    // The store holds the payload's JSON form. An appender's object can differ
    // from it: workflow definition records keep keys set to `undefined`, which
    // strict decoders of the stored fact refuse.
    return { ...storedFact(event, receipt), payload: JSON.parse(event.payloadJson ?? JSON.stringify(event.payload)) }
  }) }
}

function requireStored(settlement: EventStoreItemSettlement): StoredFact[] {
  if (settlement.kind === "rejected") throw settlement.error
  if (settlement.kind === "conflict") {
    throw new ProjectStateUnavailableError("unguarded append returned an aggregate sequence conflict")
  }
  return [...settlement.events]
}

function guardedResult(settlement: EventStoreItemSettlement): GuardedAppendResult {
  if (settlement.kind === "rejected") throw settlement.error
  return settlement
}

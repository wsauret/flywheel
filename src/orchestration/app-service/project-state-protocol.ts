import { pack, unpack, unpackMultiple } from "msgpackr"
import { isStartupStep, type StartupReached } from "../../protocol/startup-steps.js"
import { Schema } from "effect"
import {
  CorruptEventRowError,
  PersistenceWriteRefused,
  type EventStoreItemSettlement,
  type EventStoreWriteItem,
  type FactQuery,
  type FoldEvidence,
  type FoldEvidenceRequest,
  type InFlightRecord,
  type StoreAssignment,
  type StoredFact,
} from "../../infra/event-store-types.js"
import { ToolContentReferenceSchema, type ToolContentReference } from "../../infra/tool-content.js"
import { InvariantViolation } from "../../infra/invariant.js"
import type { ProjectDirectories } from "../../infra/directory-authorities.js"
import type { SessionMetadataChange } from "../session/manager.js"
import { CorruptRowSchema, fromCorruptRow, fromStateError, invariantFields, InvariantSchema, StateErrorSchema, toStateError } from "./project-state-errors.js"
import {
  ProjectStateSessionResultSchema,
  SessionMetadataChangeSchema,
  type ProjectStateSessionCommand,
  type ProjectStateSessionResult,
} from "./project-state-sessions.js"
import { decodeProjectStatePayloads, encodeProjectStatePayloads, WireSessionCommand, WireWriteItem } from "./project-state-payload.js"
import { SessionContentNodeSchema, SessionContentNodeRowSchema, SESSION_CONTENT_STAGE_BYTES, type SessionContentNode, type SessionContentNodeRow, type SessionContentRange, type SessionContentReference, type SessionContentUnavailable } from "../../infra/session-content.js"
import { SessionContentReferenceSchema, SESSION_CONTENT_WINDOW_BYTES } from "../../infra/session-content-schema.js"

export const PROJECT_STATE_MAX_QUEUED_ITEMS = 4_096

const ProjectStateStartupStepSchema = Schema.Struct({
  flywheel: Schema.Literal("state.startup.step"),
  step: Schema.String,
  pass: Schema.optionalKey(Schema.Struct({ label: Schema.NonEmptyString, step: Schema.Int, total: Schema.Int })),
})

/** The step a start reached inside the state Worker. The Worker always runs
 *  the build of the process that spawned it, so the message carries the step
 *  id and leaves its label and count to the catalog. */
export function encodeProjectStateStartupStep(reached: StartupReached) {
  return Schema.decodeUnknownSync(ProjectStateStartupStepSchema, { onExcessProperty: "error" })({ flywheel: "state.startup.step", ...reached })
}

/** A startup step from the Worker, or undefined for any other message. A
 *  step the catalog does not hold is not a message of this build, so it is
 *  refused like any other message the port does not know. */
export function decodeProjectStateStartupStep(value: unknown): StartupReached | undefined {
  // Every message on the port is offered here first, so any other kind is
  // passed over before the schema runs.
  if (typeof value !== "object" || value === null || !("flywheel" in value) || value.flywheel !== "state.startup.step") return undefined
  let message: typeof ProjectStateStartupStepSchema.Type
  try {
    message = Schema.decodeUnknownSync(ProjectStateStartupStepSchema, { onExcessProperty: "error" })(value)
  } catch {
    return undefined
  }
  if (!isStartupStep(message.step)) return undefined
  return { step: message.step, ...(message.pass === undefined ? {} : { pass: message.pass }) }
}
export const PROJECT_STATE_MAX_BYTES = 8 * 1024 * 1024
export const PROJECT_STATE_MAX_PAGE_ROWS = 256

export type ProjectStateLane = "control" | "execution"

interface ProjectStateFactPageRequest {
  readonly kind: "facts.page"
  readonly query: FactQuery
  readonly upperPosition?: number
  readonly content?: "eager" | "deferred"
  readonly afterPosition?: number
  readonly maxRows: number
  readonly maxBytes: number
  readonly tolerant?: boolean
  /** Asks for the fold evidence of `query` with the page (ARCH-SUBSTRATE-046). */
  readonly evidence?: FoldEvidenceRequest
}

export interface ProjectStateContentReference {
  readonly sessionId: string
  readonly reference: ToolContentReference
  readonly fact: {
    readonly eventType: string
    readonly eventPosition: number
    readonly aggregateId: string
  }
}

export type ProjectStateControlOperation =
  | { readonly kind: "position.capture" }
  | { readonly kind: "facts.latest-position"; readonly type: string }
  | { readonly kind: "facts.latest-payload"; readonly aggregateId: string; readonly type: string }
  | { readonly kind: "facts.latest-by-types"; readonly aggregateId: string; readonly types: readonly string[] }
  | { readonly kind: "facts.slice"; readonly query: FactQuery; readonly tolerant?: boolean; readonly maxRows: number; readonly maxBytes: number }
  | { readonly kind: "in-flight.read"; readonly sessionId: string; readonly kinds: readonly string[]; readonly keyPrefix?: string }
  | { readonly kind: "in-flight.sessions"; readonly inFlightKind: string }
  | { readonly kind: "in-flight.profile"; readonly inFlightKind: string; readonly profileId: string }
  | { readonly kind: "aggregate.count"; readonly aggregateId: string }
  | { readonly kind: "aggregate.sequence"; readonly aggregateId: string }
  | ProjectStateFactPageRequest
  | { readonly kind: "content.page"; readonly references: readonly ProjectStateContentReference[]; readonly offset?: number; readonly maxRows: number; readonly maxBytes: number }
  | { readonly kind: "content.stage"; readonly sessionId: string; readonly nodes: readonly SessionContentNodeRow[] }
  | { readonly kind: "content.node"; readonly sessionId: string; readonly sha256: string; readonly maxBytes: number }
  | { readonly kind: "content.range"; readonly sessionId: string; readonly reference: SessionContentReference; readonly offset: number; readonly length: number; readonly maxBytes: number }
  | { readonly kind: "append"; readonly item: EventStoreWriteItem }
  | { readonly kind: "append.batch"; readonly items: readonly EventStoreWriteItem[] }
  | { readonly kind: "maintenance.prune"; readonly aggregateId: string; readonly eventType: string }
  | { readonly kind: "maintenance.prune-keyed"; readonly aggregateId: string; readonly eventType: string; readonly payloadKey: string }
  /** Startup maintenance's store upkeep, which the sole writer runs in
   *  bounded steps: one chunk of one retired family, or the retired indexes. */
  | { readonly kind: "maintenance.prune-retired"; readonly eventType: string }
  | { readonly kind: "maintenance.drop-retired-indexes" }
  | { readonly kind: "maintenance.finalized-checkpoints"; readonly afterRowid: number; readonly throughRowid: number; readonly evidencePositions: readonly number[] }
  | { readonly kind: "session.control"; readonly command: ProjectStateSessionCommand }

export type ProjectStateExecutionOperation =
  | { readonly kind: "generation.admit"; readonly projectId: string; readonly generation: number }
  | { readonly kind: "execution.operation"; readonly projectId: string; readonly generation: number; readonly operation: ProjectStateControlOperation }
  | { readonly kind: "generation.close"; readonly projectId: string; readonly generation: number }
  /** `interruptedSessionIds` names the sessions a person was interrupting
   *  when the account ended the generation to stop them; their recovery
   *  records the person's interrupt instead of an unexpected exit. */
  | { readonly kind: "generation.recover"; readonly projectId: string; readonly generation: number; readonly interruptedSessionIds?: readonly string[] }

export type ProjectStateOperation = ProjectStateControlOperation | ProjectStateExecutionOperation

export interface ProjectStateRequest {
  readonly id: number
  readonly lane: ProjectStateLane
  readonly operation: ProjectStateOperation
}

export type ProjectStateResult =
  | { readonly kind: "ok" }
  | { readonly kind: "position"; readonly position: number }
  | { readonly kind: "latest-payload"; readonly payload: string | null }
  | { readonly kind: "fact-list"; readonly facts: readonly StoredFact[] }
  | { readonly kind: "in-flight"; readonly records: readonly InFlightRecord[] }
  | { readonly kind: "in-flight.profile"; readonly found: boolean }
  | { readonly kind: "session-ids"; readonly sessionIds: readonly string[] }
  | { readonly kind: "count"; readonly count: number }
  | { readonly kind: "sequence"; readonly sequence: number }
  | { readonly kind: "fact-slice"; readonly facts: readonly (StoredFact | CorruptEventRowError)[]; readonly contentRows: readonly ProjectStateContentRow[]; readonly encodedBytes: number }
  | { readonly kind: "facts"; readonly facts: readonly (StoredFact | CorruptEventRowError)[]; readonly contentRows: readonly ProjectStateContentRow[]; readonly upperPosition: number; readonly continuationPosition: number | null; readonly encodedBytes: number; readonly foldEvidence?: FoldEvidence }
  | { readonly kind: "content"; readonly rows: readonly ProjectStateContentRow[]; readonly continuationOffset: number | null; readonly encodedBytes: number }
  | { readonly kind: "content.node"; readonly sessionId: string; readonly sha256: string; readonly value: SessionContentUnavailable | { readonly kind: "available"; readonly node: SessionContentNode } }
  | { readonly kind: "content.range"; readonly sessionId: string; readonly reference: SessionContentReference; readonly requestedOffset: number; readonly requestedLength: number; readonly range: SessionContentRange }
  | { readonly kind: "stored"; readonly settlements: readonly ProjectStateSettlement[] }
  | { readonly kind: "maintenance"; readonly affected: number }
  | { readonly kind: "checkpoint-maintenance"; readonly afterRowid: number; readonly examined: number; readonly retired: number; readonly complete: boolean; readonly transactionMs: number }
  | { readonly kind: "session-result"; readonly result: ProjectStateSessionResult }
  | { readonly kind: "refused"; readonly reason: "oversize" | "pressure" | "stale-generation" | "closed-generation" | "unsafe-recovery" | "invalid"; readonly message?: string }
  | { readonly kind: "failed"; readonly error: Error }

/** One appended fact in an acknowledgement. The appender holds every field
 *  the store did not assign, so the acknowledgement carries only the
 *  assignment. A fact that the state Worker's historical recovery rewrote is
 *  not the one the appender sent, so it travels whole. */
type StoredFactReceipt = StoreAssignment | StoredFact

/** One append item's outcome on the wire; `storedSettlement` completes it. */
export type ProjectStateSettlement =
  | { readonly kind: "stored"; readonly receipts: readonly StoredFactReceipt[] }
  | Exclude<EventStoreItemSettlement, { readonly kind: "stored" }>

export type ProjectStateContentRow =
  | { readonly reference: ProjectStateContentReference; readonly content: string }
  | { readonly reference: ProjectStateContentReference; readonly error: InvariantViolation }

/** What the state Worker served for one request. `head` is the store's
 *  newest committed position, read after the request ran and after the
 *  notifications of every commit before it were posted, so it is at least
 *  the position of every commit that completed before the request reached
 *  the Worker. A result the Worker did not serve, such as a refusal for
 *  pressure, and a result that the account made itself carry no head. */
export interface ProjectStateServed {
  readonly result: ProjectStateResult
  readonly head?: number
}

export interface ProjectStateResponse extends ProjectStateServed {
  readonly id: number
}

export interface ProjectStateWorkerInit {
  readonly flywheel: "state.init"
  readonly directories: ProjectDirectories
  readonly executionCwd: string
  readonly predecessorPids?: readonly number[]
  readonly controlPort: MessagePort
  readonly executionPort: MessagePort
}

export interface ProjectStateSessionChange {
  readonly flywheel: "state.session-change"
  readonly change: SessionMetadataChange
}

/** Committed facts share the response port so delivery precedes acknowledgement. */
export interface ProjectStateStored {
  readonly flywheel: "state.stored"
  readonly events: readonly StoredFact[]
}

export function encodeProjectStateStored(events: readonly StoredFact[]): ProjectStateStored {
  return { flywheel: "state.stored", events }
}

/** The fact a `state.stored` broadcast carries in place of a committed fact
 *  whose historical conversion failed. Its payload is not the stored one, so
 *  a reader that needs the stored fact must read it from the store. */
export function degradedStoredFact(fact: StoredFact, reason: string): StoredFact {
  return { ...fact, payload: { kind: "degraded", reason } }
}

/** True for a fact `degradedStoredFact` built. A stored fact that happens to
 *  have the same payload is also true, which only sends its reader to the store. */
export function isDegradedStoredFact(fact: StoredFact): boolean {
  const keys = Object.keys(fact.payload)
  return fact.payload.kind === "degraded" && typeof fact.payload.reason === "string" && keys.length === 2
}

export function decodeProjectStateStored(value: unknown): ProjectStateStored | undefined {
  try {
    return Schema.decodeUnknownSync(StoredSchema, { onExcessProperty: "error" })(value)
  } catch {
    return undefined
  }
}

export interface ProjectStateAdmission {
  readonly bytes: number
  readonly units: number
}

/** Encodes and measures the complete outbound request in an owned, exact-size transferable buffer. */
export function encodeProjectStateRequest(request: ProjectStateRequest, limitBytes = PROJECT_STATE_MAX_BYTES): Uint8Array {
  try {
    const operation = request.operation.kind === "execution.operation" ? request.operation.operation : request.operation
    const frameLimit = operation.kind === "content.stage" ? Math.min(limitBytes, SESSION_CONTENT_STAGE_BYTES) : limitBytes
    if (operation.kind === "content.stage") {
      const nodeBytes = Buffer.byteLength(JSON.stringify(operation.nodes))
      if (nodeBytes > SESSION_CONTENT_STAGE_BYTES) throw new PersistenceWriteRefused(nodeBytes, SESSION_CONTENT_STAGE_BYTES)
    }
    return encodeProjectStateFrame({ ...request, operation: encodeProjectStatePayloads(request.operation) }, frameLimit)
  } catch (error) {
    if (error instanceof PersistenceWriteRefused) error.requestId = request.id
    throw error
  }
}

/** Bounds complete requests. Response frames retain the transport's own bounds. */
function encodeProjectStateFrame(value: unknown, limitBytes = PROJECT_STATE_MAX_BYTES): Uint8Array {
  const encoded = pack(value)
  if (encoded.byteLength > limitBytes) throw new PersistenceWriteRefused(encoded.byteLength, limitBytes)
  return new Uint8Array(encoded)
}

export function boundedProjectStatePage(maxRows: number, maxBytes: number): boolean {
  return Number.isSafeInteger(maxRows) && maxRows > 0 && maxRows <= PROJECT_STATE_MAX_PAGE_ROWS
    && Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= PROJECT_STATE_MAX_BYTES
}

export function boundedProjectStateSlice(query: FactQuery, maxRows: number, maxBytes: number): boolean {
  if (!boundedProjectStatePage(maxRows, maxBytes)) return false
  return (query.limit !== undefined && query.limit <= maxRows)
    || (query.positions !== undefined && query.positions.length <= maxRows)
}

export function decodeProjectStateRequest(value: unknown, lane?: ProjectStateLane): ProjectStateRequest | undefined {
  try {
    if (!(value instanceof Uint8Array) || value.byteLength > PROJECT_STATE_MAX_BYTES) return undefined
    const wire = Schema.decodeUnknownSync(WireRequestSchema, { onExcessProperty: "error" })(unpack(value))
    const request: ProjectStateRequest = { ...wire, operation: decodeProjectStatePayloads(wire.operation) }
    checkRequestRoute(request, lane)
    return request
  } catch {
    return undefined
  }
}

/** Throws the failure of a request that typed code built and the receiver
 *  would refuse because of where it travels: a lane it does not belong to or
 *  an unbounded fact slice. Typed code builds every field, and the receiver
 *  decodes the whole request strictly, so the sender decodes nothing. */
export function validateProjectStateRequest(request: ProjectStateRequest, lane?: ProjectStateLane): void {
  checkRequestRoute(request, lane)
}

function checkRequestRoute(request: ProjectStateRequest, lane: ProjectStateLane | undefined): void {
  if (lane !== undefined && request.lane !== lane) throw new Error("lane does not match the channel lane")
  if (!operationBelongsToLane(request.operation.kind, request.lane)) throw new Error("operation.kind does not belong to lane")
  const operation = request.operation.kind === "execution.operation" ? request.operation.operation : request.operation
  if (operation.kind === "facts.slice" && !boundedProjectStateSlice(operation.query, operation.maxRows, operation.maxBytes)) {
    throw new Error("operation.query.limit, maxRows, and maxBytes must bound a fact slice")
  }
}

/** A response whose request id was read and whose body was not. The frame
 *  is two MessagePack values: the request id, then the body `{ head?, result }`
 *  from `bodyOffset` on. A relay readdresses the frame to its peer's request
 *  without reading the body, so only the peer that consumes it decodes it. */
export interface ProjectStateResponseFrame {
  readonly id: number
  readonly bytes: Uint8Array
  readonly bodyOffset: number
}

/** Reads only the request id of a response frame, or undefined for bytes
 *  that do not start with a request id and continue with a body. */
export function readProjectStateResponseFrame(bytes: Uint8Array): ProjectStateResponseFrame | undefined {
  let id: unknown
  let bodyOffset: number | undefined
  try {
    unpackMultiple(bytes, (value, _start, end) => {
      id = value
      bodyOffset = end
      return false
    })
  } catch {
    return undefined
  }
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 && bodyOffset !== undefined && bodyOffset < bytes.byteLength
    ? { id, bytes, bodyOffset }
    : undefined
}

/** Reads and validates a whole response from the frame bytes that
 *  `encodeProjectStateResponse` made, or undefined for any other message. */
export function decodeProjectStateResponse(value: unknown): ProjectStateResponse | undefined {
  if (!(value instanceof Uint8Array)) return undefined
  const frame = readProjectStateResponseFrame(value)
  if (!frame) return undefined
  try {
    const { id, head, result } = Schema.decodeUnknownSync(ResponseSchema, { onExcessProperty: "error" })({ ...unpack(value.subarray(frame.bodyOffset)), id: frame.id })
    return { id, result: decodedResult(result), ...(head === undefined ? {} : { head }) }
  } catch {
    return undefined
  }
}

function decodedResult(result: typeof ResponseSchema.Type["result"]): ProjectStateResult {
  switch (result.kind) {
    case "in-flight": return { ...result, records: result.records.map((record) => ({ ...record, payload: Schema.decodeUnknownSync(Schema.fromJsonString(Payload))(record.raw) })) }
    case "failed": return { ...result, error: fromStateError(result.error) }
    case "facts":
    case "fact-slice": return { ...result, facts: result.facts.map((fact) => "error" in fact ? fromCorruptRow(fact.error) : fact),
      contentRows: result.contentRows.map((row) => "error" in row ? { ...row, error: new InvariantViolation(row.error) } : row) }
    case "stored": return { ...result, settlements: result.settlements.map((item): ProjectStateSettlement =>
      item.kind === "stored"
        ? { ...item, receipts: [...item.receipts] }
        : item.kind === "conflict"
          ? item
          : { ...item, error: fromStateError(item.error) }) }
    case "content": return { ...result, rows: result.rows.map((row) =>
      "error" in row ? { ...row, error: new InvariantViolation(row.error) } : row) }
    default: return result
  }
}

export function encodeProjectStateSessionChange(change: SessionMetadataChange): ProjectStateSessionChange {
  return Schema.decodeUnknownSync(SessionChangeSchema, { onExcessProperty: "error" })({
    flywheel: "state.session-change",
    change,
  })
}

function decodeProjectStateSessionChange(value: unknown): ProjectStateSessionChange | undefined {
  try {
    return Schema.decodeUnknownSync(SessionChangeSchema, { onExcessProperty: "error" })(value)
  } catch {
    return undefined
  }
}

type ProjectStateMessage =
  | { readonly kind: "response"; readonly frame: ProjectStateResponseFrame }
  | { readonly kind: "stored"; readonly events: readonly StoredFact[] }
  | { readonly kind: "session-change"; readonly change: SessionMetadataChange }

/** One message a state client receives, or undefined for a message of no
 *  kind it knows. A response is always the bytes `encodeProjectStateResponse`
 *  made and a broadcast is always a tagged object, so each message meets only
 *  the decoder of its own kind. A response arrives with its body unread: the
 *  client reads the body of a request it consumes and relays the rest. */
export function decodeProjectStateMessage(value: unknown): ProjectStateMessage | undefined {
  if (value instanceof Uint8Array) {
    const frame = readProjectStateResponseFrame(value)
    return frame && { kind: "response", frame }
  }
  if (typeof value !== "object" || value === null || !("flywheel" in value)) return undefined
  if (value.flywheel === "state.stored") {
    const stored = decodeProjectStateStored(value)
    return stored && { kind: "stored", events: stored.events }
  }
  if (value.flywheel === "state.session-change") {
    const notification = decodeProjectStateSessionChange(value)
    return notification && { kind: "session-change", change: notification.change }
  }
  return undefined
}

/** Converts class-based errors to validated data in an owned, exact-size transferable buffer. */
export function encodeProjectStateResponse(response: ProjectStateResponse): Uint8Array {
  return encodeProjectStateResponseFrame(response).bytes
}

export function encodeProjectStateResponseFrame(response: ProjectStateResponse): ProjectStateResponseFrame {
  const { id, ...body } = projectStateResponseData(response)
  return addressedFrame(id, pack(body))
}

/** The same response addressed to request `id`, in an owned, exact-size
 *  transferable buffer. The body is copied, not read. */
export function readdressProjectStateResponse(frame: ProjectStateResponseFrame, id: number): Uint8Array {
  return addressedFrame(id, frame.bytes.subarray(frame.bodyOffset)).bytes
}

function addressedFrame(id: number, body: Uint8Array): ProjectStateResponseFrame {
  const address = pack(id)
  const bytes = new Uint8Array(address.byteLength + body.byteLength)
  bytes.set(address)
  bytes.set(body, address.byteLength)
  return { id, bytes, bodyOffset: address.byteLength }
}

/** Typed code built the response, and the receiver decodes it, so encoding
 *  only maps class-based errors to data. */
function projectStateResponseData({ id, head, result }: ProjectStateResponse): typeof ResponseSchema.Type {
  return { id, result: resultData(result), ...(head === undefined ? {} : { head }) }
}

function resultData(result: ProjectStateResult): typeof ResponseSchema.Type["result"] {
  switch (result.kind) {
    case "in-flight": return { ...result, records: result.records.map(({ kind, key, raw }) => ({ kind, key, raw })) }
    case "failed": return { ...result, error: toStateError(result.error) }
    case "facts":
    case "fact-slice": return { ...result, facts: result.facts.map(encodeProjectStateFact), contentRows: result.contentRows.map(encodeProjectStateContentRow) }
    case "stored": return { ...result, settlements: result.settlements.map((item) =>
      item.kind === "rejected" ? { ...item, error: toStateError(item.error) } : item) }
    case "content": return { ...result, rows: result.rows.map(encodeProjectStateContentRow) }
    default: return result
  }
}

/** The wire representation is also the unit charged to a fact page's byte budget. */
export function encodeProjectStateFact(fact: StoredFact | CorruptEventRowError) {
  return fact instanceof CorruptEventRowError ? { error: { row: fact.row, message: fact.message } } : fact
}

/** Includes reference metadata and integrity evidence in the content page budget. */
export function encodeProjectStateContentRow(row: ProjectStateContentRow) {
  return "error" in row ? { ...row, error: invariantFields(row.error) } : row
}

/** Shutdown acknowledges database disposal separately from the thread termination join. */
export function encodeProjectStateClosed(error: unknown | null): typeof ClosedSchema.Type {
  return { flywheel: "state.closed", error: error === null ? null : toStateError(error) }
}

export function decodeProjectStateClosed(value: unknown): { readonly error: Error | null } | undefined {
  try {
    const closed = Schema.decodeUnknownSync(ClosedSchema, { onExcessProperty: "error" })(value)
    return { error: closed.error === null ? null : fromStateError(closed.error) }
  } catch {
    return undefined
  }
}

export function operationUnits(operation: ProjectStateOperation): number {
  if (operation.kind === "execution.operation") return operationUnits(operation.operation)
  if (operation.kind === "append.batch") {
    return Math.max(1, operation.items.reduce((total, item) => total + Math.max(1, item.events.length), 0))
  }
  if ("item" in operation) return Math.max(1, operation.item.events.length)
  return 1
}

const Natural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Positive = Schema.Int.check(Schema.isGreaterThan(0))
const Payload = Schema.Record(Schema.String, Schema.Unknown)
const InFlightRecordSchema = Schema.Struct({
  kind: Schema.String, key: Schema.String, raw: Schema.String,
})
/** A stored fact crosses the channel opaque: the state Worker built it from
 *  its own row, and the reader that consumes it decodes its body once with
 *  the fact family's schema (`parseProjectionFact`). */
const StoredFactRow = Schema.declare((value: unknown): value is StoredFact => typeof value === "object" && value !== null && !("error" in value))
const StoredFactReceiptRow = Schema.declare((value: unknown): value is StoredFactReceipt => typeof value === "object" && value !== null && !("error" in value)
  && ("payload" in value || ("id" in value && typeof value.id === "string" && "position" in value && Number.isSafeInteger(value.position)
    && "seq" in value && Number.isSafeInteger(value.seq))))
const StoredSchema = Schema.Struct({ flywheel: Schema.Literal("state.stored"), events: Schema.Array(StoredFactRow) })
const QuerySchema = Schema.Struct({
  aggregateId: Schema.optional(Schema.String), aggregateIds: Schema.optional(Schema.Array(Schema.String)), sessionId: Schema.optional(Schema.String),
  aggregatePrefix: Schema.optional(Schema.String),
  positions: Schema.optional(Schema.Array(Natural)), types: Schema.optional(Schema.Array(Schema.String)),
  afterPosition: Schema.optional(Natural), beforePosition: Schema.optional(Natural), fromSeq: Schema.optional(Natural),
  parentToolUseIds: Schema.optional(Schema.Array(Schema.String)), toolUseIds: Schema.optional(Schema.Array(Schema.String)),
  order: Schema.optional(Schema.Literals(["asc", "desc"])), limit: Schema.optional(Natural), limitPerAggregate: Schema.optional(Natural),
})
const ReferenceSchema = Schema.Struct({
  sessionId: Schema.String, reference: ToolContentReferenceSchema,
  fact: Schema.Struct({ eventType: Schema.String, eventPosition: Positive, aggregateId: Schema.String }),
})
const PageFields = { maxRows: Positive.check(Schema.isLessThanOrEqualTo(PROJECT_STATE_MAX_PAGE_ROWS)), maxBytes: Positive.check(Schema.isLessThanOrEqualTo(PROJECT_STATE_MAX_BYTES)) }
const GenerationFields = { projectId: Schema.NonEmptyString, generation: Positive }
const ContentBudget = Positive.check(Schema.isLessThanOrEqualTo(PROJECT_STATE_MAX_BYTES))
const ContentHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const ContentUnavailableSchema = Schema.Struct({ kind: Schema.Literal("unavailable"), reason: Schema.Literals(["missing", "corrupt"]) })
const WireControlOperationSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("position.capture") }),
  Schema.Struct({ kind: Schema.Literal("facts.latest-position"), type: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("facts.latest-payload"), aggregateId: Schema.String, type: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("facts.latest-by-types"), aggregateId: Schema.String, types: Schema.Array(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("facts.slice"), query: QuerySchema, tolerant: Schema.optional(Schema.Boolean), ...PageFields }),
  Schema.Struct({ kind: Schema.Literal("in-flight.read"), sessionId: Schema.String, kinds: Schema.Array(Schema.String), keyPrefix: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("in-flight.sessions"), inFlightKind: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("in-flight.profile"), inFlightKind: Schema.String, profileId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("aggregate.count"), aggregateId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("aggregate.sequence"), aggregateId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("facts.page"), query: QuerySchema, upperPosition: Schema.optional(Natural), content: Schema.optional(Schema.Literals(["eager", "deferred"])), afterPosition: Schema.optional(Natural), tolerant: Schema.optional(Schema.Boolean), evidence: Schema.optional(Schema.Struct({ anchorAt: Natural })), ...PageFields }),
  Schema.Struct({ kind: Schema.Literal("content.page"), references: Schema.Array(ReferenceSchema), offset: Schema.optional(Natural), ...PageFields }),
  Schema.Struct({ kind: Schema.Literal("content.stage"), sessionId: Schema.String, nodes: Schema.Array(SessionContentNodeRowSchema) }),
  Schema.Struct({ kind: Schema.Literal("content.node"), sessionId: Schema.String, sha256: ContentHash, maxBytes: ContentBudget }),
  Schema.Struct({ kind: Schema.Literal("content.range"), sessionId: Schema.String, reference: SessionContentReferenceSchema, offset: Natural, length: Natural.check(Schema.isLessThanOrEqualTo(SESSION_CONTENT_WINDOW_BYTES)), maxBytes: ContentBudget }),
  Schema.Struct({ kind: Schema.Literal("append"), item: WireWriteItem }),
  Schema.Struct({ kind: Schema.Literal("append.batch"), items: Schema.Array(WireWriteItem) }),
  Schema.Struct({ kind: Schema.Literal("maintenance.prune"), aggregateId: Schema.String, eventType: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("maintenance.prune-keyed"), aggregateId: Schema.String, eventType: Schema.String, payloadKey: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("maintenance.prune-retired"), eventType: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("maintenance.drop-retired-indexes") }),
  Schema.Struct({ kind: Schema.Literal("maintenance.finalized-checkpoints"), afterRowid: Natural, throughRowid: Natural, evidencePositions: Schema.Array(Positive) }),
  Schema.Struct({ kind: Schema.Literal("session.control"), command: WireSessionCommand }),
])
const WireRequestSchema = Schema.Struct({
  id: Positive,
  lane: Schema.Literals(["control", "execution"]),
  operation: Schema.Union([
    WireControlOperationSchema,
    Schema.Struct({ kind: Schema.Literal("execution.operation"), ...GenerationFields, operation: WireControlOperationSchema }),
    Schema.Struct({ kind: Schema.Literals(["generation.admit", "generation.close"]), ...GenerationFields }),
    Schema.Struct({ kind: Schema.Literal("generation.recover"), ...GenerationFields, interruptedSessionIds: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)) }),
  ]),
})
const ClosedSchema = Schema.Struct({ flywheel: Schema.Literal("state.closed"), error: Schema.NullOr(StateErrorSchema) })
const SessionChangeSchema = Schema.Struct({ flywheel: Schema.Literal("state.session-change"), change: SessionMetadataChangeSchema })
const ContentRowSchema = Schema.Union([
  Schema.Struct({ reference: ReferenceSchema, content: Schema.String }),
  Schema.Struct({ reference: ReferenceSchema, error: InvariantSchema }),
])
const ResponseSchema = Schema.Struct({
  id: Positive,
  head: Schema.optional(Natural),
  result: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("ok") }),
    Schema.Struct({ kind: Schema.Literal("position"), position: Natural }),
    Schema.Struct({ kind: Schema.Literal("latest-payload"), payload: Schema.NullOr(Schema.String) }),
    Schema.Struct({ kind: Schema.Literal("fact-list"), facts: Schema.Array(StoredFactRow) }),
    Schema.Struct({ kind: Schema.Literal("in-flight"), records: Schema.Array(InFlightRecordSchema) }),
    Schema.Struct({ kind: Schema.Literal("in-flight.profile"), found: Schema.Boolean }),
    Schema.Struct({ kind: Schema.Literal("session-ids"), sessionIds: Schema.Array(Schema.String) }),
    Schema.Struct({ kind: Schema.Literal("count"), count: Natural }),
    Schema.Struct({ kind: Schema.Literal("sequence"), sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1)) }),
    Schema.Struct({ kind: Schema.Literal("fact-slice"), facts: Schema.Array(Schema.Union([StoredFactRow, Schema.Struct({ error: CorruptRowSchema })])), contentRows: Schema.Array(ContentRowSchema), encodedBytes: Natural }),
    Schema.Struct({ kind: Schema.Literal("facts"), facts: Schema.Array(Schema.Union([StoredFactRow, Schema.Struct({ error: CorruptRowSchema })])), contentRows: Schema.Array(ContentRowSchema), upperPosition: Natural, continuationPosition: Schema.NullOr(Natural), encodedBytes: Natural,
      foldEvidence: Schema.optional(Schema.Struct({ head: Natural, generation: Natural, anchor: Schema.NullOr(Schema.Struct({ position: Positive, id: Schema.String })) })) }),
    Schema.Struct({ kind: Schema.Literal("content"), rows: Schema.Array(ContentRowSchema), continuationOffset: Schema.NullOr(Natural), encodedBytes: Natural }),
    Schema.Struct({ kind: Schema.Literal("content.node"), sessionId: Schema.String, sha256: ContentHash, value: Schema.Union([
      ContentUnavailableSchema, Schema.Struct({ kind: Schema.Literal("available"), node: SessionContentNodeSchema }),
    ]) }),
    Schema.Struct({ kind: Schema.Literal("content.range"), sessionId: Schema.String, reference: SessionContentReferenceSchema, requestedOffset: Natural, requestedLength: Natural, range: Schema.Union([
      ContentUnavailableSchema, Schema.Struct({ kind: Schema.Literal("available"), offset: Natural, base64: Schema.String, nextOffset: Schema.NullOr(Natural) }),
    ]) }),
    Schema.Struct({ kind: Schema.Literal("stored"), settlements: Schema.Array(Schema.Union([
      Schema.Struct({ kind: Schema.Literal("stored"), receipts: Schema.Array(StoredFactReceiptRow) }),
      Schema.Struct({ kind: Schema.Literal("conflict"), conflict: Schema.Struct({ aggregateId: Schema.String, expectedSeq: Natural, actualSeq: Natural }) }),
      Schema.Struct({ kind: Schema.Literal("rejected"), error: StateErrorSchema }),
    ])) }),
    Schema.Struct({ kind: Schema.Literal("maintenance"), affected: Natural }),
    Schema.Struct({ kind: Schema.Literal("checkpoint-maintenance"), afterRowid: Natural, examined: Natural, retired: Natural, complete: Schema.Boolean, transactionMs: Schema.Number }),
    Schema.Struct({ kind: Schema.Literal("session-result"), result: ProjectStateSessionResultSchema }),
    Schema.Struct({ kind: Schema.Literal("refused"), reason: Schema.Literals(["oversize", "pressure", "stale-generation", "closed-generation", "unsafe-recovery", "invalid"]), message: Schema.optional(Schema.String) }),
    Schema.Struct({ kind: Schema.Literal("failed"), error: StateErrorSchema }),
  ]),
})

function operationBelongsToLane(kind: string, lane: ProjectStateLane): boolean {
  if (lane === "execution") {
    return kind === "generation.admit" || kind === "generation.close" || kind === "generation.recover" || kind === "execution.operation"
  }
  return kind === "position.capture" || kind === "facts.latest-position" || kind === "facts.latest-payload"
    || kind === "facts.latest-by-types" || kind === "facts.slice" || kind === "in-flight.read"
    || kind === "in-flight.sessions" || kind === "in-flight.profile" || kind === "aggregate.count" || kind === "aggregate.sequence"
    || kind === "facts.page" || kind === "content.page" || kind === "content.stage" || kind === "content.node" || kind === "content.range"
    || kind === "append" || kind === "append.batch"
    || kind === "maintenance.prune" || kind === "maintenance.prune-keyed"
    || kind === "maintenance.prune-retired" || kind === "maintenance.drop-retired-indexes" || kind === "maintenance.finalized-checkpoints"
    || kind === "session.control"
}

import { Schema } from "effect"
import { decodeServeStartRefusal, ServeStartupFailure, startRefusalOf } from "../../protocol/serve-handshake.js"
import { CorruptEventRowError, InFlightSwapConflictError, PersistenceWriteRefused } from "../../infra/event-store-types.js"
import { InvariantViolation } from "../../infra/invariant.js"
import { errorMessage } from "../../infra/error-message.js"
import { ParentPublicationContendedError, SessionForkRefusal } from "../session/manager.js"
import { WorkflowParentRefusal } from "../session/child-session-publication.js"

const Natural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Positive = Schema.Int.check(Schema.isGreaterThan(0))

export const InvariantSchema = Schema.Struct({
  kind: Schema.Literals(["missing-producer-event", "orphan-event", "duplicate-event", "schema-mismatch", "idempotency-violation", "dispose-failure"]),
  eventType: Schema.String, eventPosition: Natural, aggregateId: Schema.String, detail: Schema.String,
})
export const CorruptRowSchema = Schema.Struct({
  row: Schema.Struct({
    aggregateId: Schema.String, seq: Natural, type: Schema.String, version: Natural, timestamp: Schema.Number,
    actor: Schema.String, sessionId: Schema.String, eventId: Schema.String, position: Positive, rawPayload: Schema.String,
  }),
  message: Schema.String,
})
/** An error as the state channel carries it: the classes a caller tells
 *  apart cross as data and are rebuilt on the other side. */
export const StateErrorSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("persistence-write-refused"), encodedBytes: Natural, limitBytes: Natural, stage: Schema.optionalKey(Schema.Literals(["preparation", "publication", "final-result"])), requestId: Schema.optionalKey(Positive) }),
  Schema.Struct({ kind: Schema.Literal("inflight-conflict"), sessionId: Schema.String, cellKind: Schema.String, key: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("corrupt-row"), ...CorruptRowSchema.fields }),
  Schema.Struct({ kind: Schema.Literal("invariant"), invariant: InvariantSchema }),
  Schema.Struct({ kind: Schema.Literal("session-fork-refusal"), message: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("parent-publication-contended"), message: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("workflow-parent-refusal"), message: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("start-refusal"), message: Schema.String, refusal: Schema.Unknown }),
  Schema.Struct({ kind: Schema.Literal("error"), message: Schema.String }),
])

export function invariantFields(error: InvariantViolation): typeof InvariantSchema.Type {
  return { kind: error.kind, eventType: error.eventType, eventPosition: error.eventPosition, aggregateId: error.aggregateId, detail: error.detail }
}

export function toStateError(error: unknown): typeof StateErrorSchema.Type {
  if (error instanceof PersistenceWriteRefused) return { kind: "persistence-write-refused", encodedBytes: error.encodedBytes, limitBytes: error.limitBytes, ...(error.stage ? { stage: error.stage } : {}), ...(error.requestId ? { requestId: error.requestId } : {}) }
  if (error instanceof InFlightSwapConflictError) return { kind: "inflight-conflict", sessionId: error.sessionId, cellKind: error.kind, key: error.key }
  if (error instanceof CorruptEventRowError) return { kind: "corrupt-row", row: error.row, message: error.message }
  if (error instanceof InvariantViolation) return { kind: "invariant", invariant: invariantFields(error) }
  if (error instanceof SessionForkRefusal) return { kind: "session-fork-refusal", message: error.message }
  if (error instanceof ParentPublicationContendedError) return { kind: "parent-publication-contended", message: error.message }
  if (error instanceof WorkflowParentRefusal) return { kind: "workflow-parent-refusal", message: error.message }
  const refusal = startRefusalOf(error)
  if (refusal !== undefined) return { kind: "start-refusal", message: errorMessage(error), refusal }
  return { kind: "error", message: errorMessage(error) }
}

export function fromCorruptRow(error: typeof CorruptRowSchema.Type): CorruptEventRowError {
  const restored = new CorruptEventRowError(error.row, "")
  restored.message = error.message
  return restored
}

export function fromStateError(error: typeof StateErrorSchema.Type): Error {
  switch (error.kind) {
    case "persistence-write-refused": {
      const refusal = new PersistenceWriteRefused(error.encodedBytes, error.limitBytes, error.stage)
      refusal.requestId = error.requestId
      return refusal
    }
    case "inflight-conflict": return new InFlightSwapConflictError(error.sessionId, error.cellKind, error.key)
    case "corrupt-row": return fromCorruptRow(error)
    case "invariant": return new InvariantViolation(error.invariant)
    case "session-fork-refusal": return new SessionForkRefusal(error.message)
    case "parent-publication-contended": return new ParentPublicationContendedError(error.message)
    case "workflow-parent-refusal": return new WorkflowParentRefusal(error.message)
    case "start-refusal": return new ServeStartupFailure(error.message, decodeServeStartRefusal(error.refusal))
    case "error": return new Error(error.message)
  }
}

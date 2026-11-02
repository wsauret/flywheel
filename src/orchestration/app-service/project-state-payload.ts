import { Schema } from "effect"
import type { EventStoreWriteItem, GuardedEventStoreAppend, InFlightWrite } from "../../infra/event-store-types.js"
import { EventStoreAppendSchema, InFlightSwapSchema, PublishSubagentInputSchema, PublishWorkflowInputSchema, projectStateSessionCommandSchema } from "./project-state-sessions.js"
import type { ProjectStateControlOperation, ProjectStateOperation } from "./project-state-protocol.js"
import { SessionContentNodeRowSchema } from "../../infra/session-content.js"

const WireSwap = InFlightSwapSchema.mapFields(({ payload: _payload, payloadJson: _json, ...fields }) => ({ ...fields, payloadJson: Schema.NullOr(Schema.String) }))
const WireCell = Schema.Union([
  Schema.Struct({ op: Schema.Literal("put"), kind: Schema.String, key: Schema.String, payloadJson: Schema.String }),
  Schema.Struct({ op: Schema.Literal("drop"), kind: Schema.String, key: Schema.String, sessionId: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ op: Schema.Literal("clear"), kind: Schema.String }),
  Schema.Struct({ op: Schema.Literal("clear_session") }),
  WireSwap,
])
const WireAppend = EventStoreAppendSchema.mapFields(({ payload: _payload, payloadJson: _json, inFlight: _cells, ...fields }) => ({
  ...fields, payloadJson: Schema.String, inFlight: Schema.optionalKey(Schema.Array(WireCell)),
}))
export const WireWriteItem = Schema.Struct({
  sessionId: Schema.String, events: Schema.Array(WireAppend), inFlight: Schema.optionalKey(Schema.Array(WireCell)),
  sessionContentNodes: Schema.optionalKey(Schema.Array(SessionContentNodeRowSchema)),
})
export const WireSessionCommand = projectStateSessionCommandSchema(
  PublishWorkflowInputSchema.mapFields((fields) => ({ ...fields, retainedOperation: Schema.optionalKey(WireSwap) })),
  PublishSubagentInputSchema.mapFields((fields) => ({ ...fields, runBinding: WireAppend, promptFact: WireAppend })),
  WireAppend,
)
type WireCell = typeof WireCell.Type
type WireAppend = typeof WireAppend.Type
type WireItem = typeof WireWriteItem.Type
type WireCommand = typeof WireSessionCommand.Type
type WireControl = Exclude<WireOperation, { kind: "execution.operation" | "generation.admit" | "generation.close" | "generation.recover" }>
type WireOperation = Exclude<ProjectStateOperation, { kind: "append" | "append.batch" | "session.control" | "execution.operation" }>
  | { readonly kind: "append"; readonly item: WireItem }
  | { readonly kind: "append.batch"; readonly items: readonly WireItem[] }
  | { readonly kind: "session.control"; readonly command: WireCommand }
  | { readonly kind: "execution.operation"; readonly projectId: string; readonly generation: number; readonly operation: Exclude<WireOperation, { kind: "execution.operation" | "generation.admit" | "generation.close" | "generation.recover" }> }

function encodeCell(write: InFlightWrite): WireCell {
  if (write.op !== "put" && write.op !== "swap") return write
  if (write.op === "swap") return encodeSwap(write)
  const { payload, ...fields } = write
  return { ...fields, payloadJson: write.payloadJson ?? JSON.stringify(payload) }
}
function encodeSwap(write: Extract<InFlightWrite, { op: "swap" }>): typeof WireSwap.Type {
  const { payload, ...fields } = write
  return { ...fields, payloadJson: write.payloadJson ?? (payload === null ? null : JSON.stringify(payload)) }
}
function encodeAppend(event: GuardedEventStoreAppend): WireAppend {
  const { payload, inFlight, ...fields } = event
  return { ...fields, payloadJson: event.payloadJson ?? JSON.stringify(payload), ...(inFlight ? { inFlight: inFlight.map(encodeCell) } : {}) }
}
function encodeItem(item: EventStoreWriteItem): WireItem {
  return { sessionId: item.sessionId, events: item.events.map(encodeAppend), ...(item.inFlight ? { inFlight: item.inFlight.map(encodeCell) } : {}), ...(item.sessionContentNodes ? { sessionContentNodes: item.sessionContentNodes } : {}) }
}

/** Serializes durable payloads once; user-content records are never traversed. */
export function encodeProjectStatePayloads(operation: ProjectStateControlOperation): WireControl
export function encodeProjectStatePayloads(operation: ProjectStateOperation): WireOperation
export function encodeProjectStatePayloads(operation: ProjectStateOperation): WireOperation {
  switch (operation.kind) {
    case "execution.operation": return { ...operation, operation: encodeProjectStatePayloads(operation.operation) }
    case "append": return { ...operation, item: encodeItem(operation.item) }
    case "append.batch": return { ...operation, items: operation.items.map(encodeItem) }
    case "session.control": {
      const command = operation.command
      switch (command.kind) {
        case "session.publish-workflow": {
          const { retainedOperation, ...input } = command.input
          return { ...operation, command: { ...command, input: { ...input, ...(retainedOperation ? { retainedOperation: encodeSwap(retainedOperation) } : {}) } } }
        }
        case "session.publish-subagent": return { ...operation, command: { ...command, input: { ...command.input, runBinding: encodeAppend(command.input.runBinding), promptFact: encodeAppend(command.input.promptFact) } } }
        case "session.commit-workflow": return { ...operation, command: { ...command, input: { ...command.input, events: command.input.events.map(encodeAppend) } } }
        case "session.publish-activation": return { ...operation, command: { ...command, facts: command.facts.map(encodeAppend) } }
        default: return { ...operation, command }
      }
    }
    default: return operation
  }
}

const parsePayload = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))
function decodeCell(cell: WireCell): InFlightWrite {
  return cell.op === "put" || cell.op === "swap" ? { ...cell, payload: cell.payloadJson === null ? null : JSON.parse(cell.payloadJson) } : cell
}
function decodeAppend(event: WireAppend): GuardedEventStoreAppend {
  const { inFlight, ...fields } = event
  return { ...fields, payload: parsePayload(event.payloadJson), ...(inFlight ? { inFlight: inFlight.map(decodeCell) } : {}) }
}
function decodeItem(item: WireItem): EventStoreWriteItem {
  return { sessionId: item.sessionId, events: item.events.map(decodeAppend), ...(item.inFlight ? { inFlight: item.inFlight.map(decodeCell) } : {}), ...(item.sessionContentNodes ? { sessionContentNodes: item.sessionContentNodes } : {}) }
}
/** Receives schema-decoded wire DTOs and restores canonical durable inputs. */
export function decodeProjectStatePayloads(operation: WireControl): ProjectStateControlOperation
export function decodeProjectStatePayloads(operation: WireOperation): ProjectStateOperation
export function decodeProjectStatePayloads(operation: WireOperation): ProjectStateOperation {
  switch (operation.kind) {
    case "execution.operation": return { ...operation, operation: decodeProjectStatePayloads(operation.operation) }
    case "append": return { ...operation, item: decodeItem(operation.item) }
    case "append.batch": return { ...operation, items: operation.items.map(decodeItem) }
    case "session.control": {
      const command = operation.command
      switch (command.kind) {
        case "session.publish-workflow": {
          const { retainedOperation, ...input } = command.input
          return { ...operation, command: { ...command, input: { ...input, ...(retainedOperation ? { retainedOperation: { ...retainedOperation, payload: retainedOperation.payloadJson === null ? null : JSON.parse(retainedOperation.payloadJson) } } : {}) } } }
        }
        case "session.publish-subagent": return { ...operation, command: { ...command, input: { ...command.input, runBinding: decodeAppend(command.input.runBinding), promptFact: decodeAppend(command.input.promptFact) } } }
        case "session.commit-workflow": return { ...operation, command: { ...command, input: { ...command.input, events: command.input.events.map(decodeAppend) } } }
        case "session.publish-activation": return { ...operation, command: { ...command, facts: command.facts.map(decodeAppend) } }
        default: return { ...operation, command }
      }
    }
    default: return operation
  }
}

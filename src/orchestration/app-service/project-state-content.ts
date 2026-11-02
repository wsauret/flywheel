import { CorruptEventRowError, type EventStoreReadSurface, type StoredFact } from "../../infra/event-store-types.js"
import { pack } from "msgpackr"
import { InvariantViolation } from "../../infra/invariant.js"
import { readToolContentReference } from "../../infra/tool-content.js"
import { storedToolContentReferences } from "../../infra/tool-content-hydration.js"
import { parseSessionContentNodeRow, readSessionContentRange, type SessionContentRange } from "../../infra/session-content.js"
import { boundedProjectStatePage, encodeProjectStateContentRow, encodeProjectStateResponse, PROJECT_STATE_MAX_BYTES, type ProjectStateContentReference, type ProjectStateContentRow, type ProjectStateOperation, type ProjectStateResult } from "./project-state-protocol.js"

/** References only at supported fact content sites, with their source identity for deferred integrity errors. */
export function projectStateFactReferences(facts: readonly (StoredFact | CorruptEventRowError)[]): ProjectStateContentReference[] {
  return facts.flatMap((fact) => fact instanceof CorruptEventRowError || !fact.sessionId ? [] :
    storedToolContentReferences(fact).map(reference => ({
      sessionId: fact.sessionId, reference,
      fact: { eventType: fact.type, eventPosition: fact.position, aggregateId: fact.aggregateId },
    })))
}

type ContentRead = Extract<ProjectStateOperation, { kind: "content.page" | "content.node" | "content.range" }>

/** Read immutable content through the shared validator and fit the complete response frame.
 * Invalid stored nodes yield unavailable. Missing storage capability and service failures throw. */
export async function readProjectStateContent(reader: EventStoreReadSurface, operation: ContentRead): Promise<ProjectStateResult> {
  if (operation.kind === "content.page") {
    if (!boundedProjectStatePage(operation.maxRows, operation.maxBytes)) return { kind: "refused", reason: "invalid" }
    const rows: ProjectStateContentRow[] = []
    let encodedBytes = 0
    let index = operation.offset ?? 0
    for (; index < operation.references.length && rows.length < operation.maxRows; index += 1) {
      const reference = operation.references[index]
      if (!reference) break
      let row: ProjectStateContentRow
      try {
        // Bytes cross the channel unproven; the reader that hydrates them verifies.
        row = { reference, content: readToolContentReference(reader.toolContent, reference.sessionId, reference.reference, reference.fact) }
      } catch (error) {
        if (!(error instanceof InvariantViolation)) throw error
        row = { reference, error }
      }
      const bytes = pack(encodeProjectStateContentRow(row)).byteLength
      if (encodedBytes + bytes > operation.maxBytes) {
        if (rows.length === 0) return { kind: "refused", reason: "oversize" }
        break
      }
      rows.push(row)
      encodedBytes += bytes
    }
    return { kind: "content", rows, continuationOffset: index < operation.references.length ? index : null, encodedBytes }
  }
  const readNode = reader.readSessionContentNode?.bind(reader)
  if (!readNode) throw new Error("session content storage is unavailable")
  if (operation.kind === "content.node") {
    const raw = readNode(operation.sessionId, operation.sha256)
    let value: Extract<ProjectStateResult, { kind: "content.node" }>["value"]
    if (raw === null) value = { kind: "unavailable", reason: "missing" }
    else {
      try {
        value = { kind: "available", node: parseSessionContentNodeRow({ sha256: operation.sha256, node: raw }).node }
      } catch {
        value = { kind: "unavailable", reason: "corrupt" }
      }
    }
    const result = { kind: "content.node", sessionId: operation.sessionId, sha256: operation.sha256, value } as const
    return contentResponseFits(result, operation.maxBytes) ? result : { kind: "refused", reason: "oversize" }
  }
  const range = await readSessionContentRange(operation.reference, operation.offset, operation.length,
    async sha256 => readNode(operation.sessionId, sha256))
  const response = (window: SessionContentRange): ProjectStateResult => ({
    kind: "content.range", sessionId: operation.sessionId, reference: operation.reference,
    requestedOffset: operation.offset, requestedLength: operation.length, range: window,
  })
  if (contentResponseFits(response(range), operation.maxBytes)) return response(range)
  if (range.kind === "unavailable") return { kind: "refused", reason: "oversize" }
  const bytes = Buffer.from(range.base64, "base64")
  let low = 0
  let high = bytes.length - 1
  let fitted: ProjectStateResult = { kind: "refused", reason: "oversize" }
  while (low <= high) {
    const length = Math.floor((low + high) / 2)
    const end = operation.offset + length
    const candidate = response({ kind: "available", offset: operation.offset, base64: bytes.subarray(0, length).toString("base64"), nextOffset: end < operation.reference.bytes ? end : null })
    if (contentResponseFits(candidate, operation.maxBytes)) {
      if (length > 0) fitted = candidate
      low = length + 1
    } else high = length - 1
  }
  return fitted
}

/** A relayed response has a different request id. Charge its largest supported
 * representation, so the complete frame fits on both hops. */
function contentResponseFits(result: ProjectStateResult, maxBytes: number): boolean {
  return encodeProjectStateResponse({ id: Number.MAX_SAFE_INTEGER, result }).byteLength <= Math.min(maxBytes, PROJECT_STATE_MAX_BYTES)
}

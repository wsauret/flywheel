import { mock } from "bun:test"
import { asAsyncEventReadSurface, type EventStoreReadSurface, type FactQuery, type StoredFact } from "../../../../src/infra/event-store-types.js"
import type { ConversationEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types.js"
import { createMutationEvidenceRecovery } from "../../../../src/orchestration/session/mutation-evidence-recovery.js"
import { readSessionContentRange } from "../../../../src/infra/session-content.js"

export const timestamp = "2026-01-01T00:00:00.000Z"
export function row(position: number, type: string, payload: StoredFact["payload"], version = 1, aggregateId = "session:s"): StoredFact {
  return { position, id: `fact-${position}`, seq: position, aggregateId, sessionId: "s", type, version, actor: "flywheel", payload, timestamp: position }
}
export function human(id: string, parentId: string | null = null): ConversationEntry {
  return { kind: "message", id, parentId, timestamp, message: { kind: "user", content: id, origin: "human" } }
}
export function entries(position: number, values: readonly unknown[], conversationId = "c") {
  return row(position, "chat.entries.appended", { conversationId, entries: values }, 3, `conversation:${conversationId}`)
}
export function mutation(position: number, requestId: string) {
  return row(position, "file.changed", {
    mutationId: `m-${position}`, operationId: `op-${position}`, origin: { kind: "tool_call", toolUseId: `tool-${position}`, modelRequestId: requestId },
    path: "/root/a", displayPath: "a", changeKind: "created", before: null, after: { bytes: 1, sha256: "a".repeat(64), preview: "a" },
  }, 3)
}
/** Deterministic endpoint digests: equal text yields equal bytes and sha256. */
export function digest(text: string) {
  return { bytes: text.length, sha256: text.charCodeAt(0).toString(16).padStart(64, "0"), preview: text }
}
export function edit(position: number, path: string, before: string | null, after: string | null) {
  const event = mutation(position, "request")
  event.payload.path = path
  event.payload.displayPath = path
  event.payload.changeKind = before === null ? "created" : after === null ? "deleted" : "modified"
  event.payload.before = before === null ? null : digest(before)
  event.payload.after = after === null ? null : digest(after)
  return event
}
export function fixture(initial: StoredFact[]) {
  const rows = initial
  const queries: FactQuery[] = []
  const read = (query: FactQuery = {}) => {
    queries.push(query)
    const result = rows.filter(fact => (!query.sessionId || fact.sessionId === query.sessionId)
      && (!query.aggregateId || fact.aggregateId === query.aggregateId) && (!query.aggregateIds || query.aggregateIds.includes(fact.aggregateId)) && (!query.types || query.types.includes(fact.type))
      && (!query.positions || query.positions.includes(fact.position)) && fact.position > (query.afterPosition ?? 0)
      && fact.position < (query.beforePosition ?? Number.POSITIVE_INFINITY))
    return (query.order === "desc" ? result.toReversed() : result).slice(0, query.limit ?? result.length)
  }
  const reader: EventStoreReadSurface = {
    read, readTolerant: read, currentPosition: () => rows.at(-1)?.position ?? 0,
    readLatestPayloadByAggregateAndType: () => null, readLatestByAggregateAndTypes: () => [],
    readInFlight: mock(() => []), sessionsWithInFlight: () => [], hasInFlightProfile: () => false, countByAggregate: () => rows.length, aggregateSeq: () => rows.length - 1,
    foldEvidence: () => ({ head: rows.at(-1)?.position ?? 0, generation: 0, anchor: null }),
    toolContent: { resolve: mock(() => null) },
  }
  const nodes = new Map<string, unknown>()
  const canonical = createMutationEvidenceRecovery({
    ...asAsyncEventReadSurface(reader), readSessionContentNode: async (_session, hash) => nodes.get(hash) ?? null,
    readSessionContentRange: async (_session, reference, offset, length) => readSessionContentRange(reference, offset, length, async hash => nodes.get(hash) ?? null),
  }, { stageSessionContentNodes: async (_session, values) => { for (const value of values) nodes.set(value.sha256, value.node) } }).reader
  return { reader, projectionReader: canonical, rows, queries }
}

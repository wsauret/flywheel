import { factTypes } from "../../infra/event-registry.js"
import { CorruptEventRowError, type EventPayload, type EventStoreReadSurface, type StoredFact } from "../../infra/event-store-types.js"
import { isRecord } from "../../infra/record.js"
import { AGENT_INPUT_FACT_TYPES, parseAgentInputFact } from "./agent-input-facts.js"
import { ProviderRequestAuditFactSchemas, parseProviderRequestAuditFact } from "./provider-request-audit-facts.js"
import { FileMutationFactSchemas, parseFileMutationFact } from "./file-mutation-facts.js"
import { parseSessionRuntimeFact, StoredSessionRuntimeFactSchemas } from "./session-runtime-event-types.js"
import { BUDGET_FACT_TYPES } from "./budget-projection.js"
import { providerRequestIdentityFromPayload } from "./provider-request-audit-types.js"

export const EXECUTION_HISTORY_FACT_TYPES = [
  ...factTypes(StoredSessionRuntimeFactSchemas), ...factTypes(ProviderRequestAuditFactSchemas),
  ...factTypes(FileMutationFactSchemas), ...AGENT_INPUT_FACT_TYPES,
].filter(type => !BUDGET_FACT_TYPES.some(budget => budget === type))

function mutationTool(payload: EventPayload): string | undefined {
  const origin = payload.origin
  return isRecord(origin) && origin.kind === "tool_call" && typeof origin.toolUseId === "string" ? origin.toolUseId
    : typeof payload.toolUseId === "string" ? payload.toolUseId : undefined
}

/** Family anchors authorize complete units, including damaged linked members.
 * Unknown rows and ambiguous identities stay with the historical residual. */
export function executionHistoryTransferPlan(reader: EventStoreReadSurface, source: string, conversations: ReadonlyMap<string, string>, parentTools: ReadonlyMap<string, string>): ReadonlyMap<string, readonly number[]> {
  const rows = reader.readTolerant({ aggregateId: `session:${source}` })
  const owners = new Map<number, string>()
  const links = new Map<string, string | null>()
  const auditTypes = new Set(factTypes(ProviderRequestAuditFactSchemas))
  const fileTypes = new Set(factTypes(FileMutationFactSchemas))
  const inputTypes = new Set<string>(AGENT_INPUT_FACT_TYPES)
  const budgetTypes = new Set<string>(BUDGET_FACT_TYPES)
  const putLink = (key: string, owner: string) => {
    const previous = links.get(key)
    links.set(key, previous === undefined || previous === owner ? owner : null)
  }
  const envelope = (row: StoredFact) => ({ type: row.type, version: row.version, actor: row.actor, payload: row.payload })
  for (const row of rows) {
    if (row instanceof CorruptEventRowError) continue
    try {
      if (auditTypes.has(row.type)) {
        const fact = parseProviderRequestAuditFact(envelope(row))
        const conversationId = providerRequestIdentityFromPayload(fact.payload).conversationId
        const owner = typeof conversationId === "string" ? conversations.get(conversationId) : undefined
        if (!owner) continue
        owners.set(row.position, owner)
        if ("requestId" in fact.payload && typeof fact.payload.requestId === "string") putLink(`request:${fact.payload.requestId}`, owner)
      } else if (row.type === "agent_input.requested") {
        const fact = parseAgentInputFact(envelope(row))
        if (fact.type !== "agent_input.requested") continue
        const owner = conversations.get(fact.payload.conversationId)
        if (!owner) continue
        putLink(`interaction:${fact.payload.interactionId}`, owner)
        putLink(`tool:${fact.payload.toolUseId}`, owner)
        owners.set(row.position, owner)
      }
    } catch { /* boundary: an unreadable anchor supplies no ownership. */ }
  }
  // A tool's validated model-request identity connects its full display unit.
  for (const row of rows) {
    if (row instanceof CorruptEventRowError || !row.type.startsWith("tool.")) continue
    // Validation cannot add a link, so a row whose request has no owner skips it.
    if (typeof row.payload.modelRequestId !== "string" || !links.has(`request:${row.payload.modelRequestId}`)) continue
    try {
      const fact = parseSessionRuntimeFact(envelope(row))
      const payload = fact.payload
      if (!("toolUseId" in payload) || typeof payload.toolUseId !== "string"
        || !("modelRequestId" in payload) || typeof payload.modelRequestId !== "string") continue
      const owner = links.get(`request:${payload.modelRequestId}`)
      if (owner) putLink(`tool:${payload.toolUseId}`, owner)
    } catch { /* boundary: unreadable tool rows can move only through an intact unit anchor below. */ }
  }
  for (const row of rows) {
    if (row instanceof CorruptEventRowError) continue
    const payload = row.payload
    const interaction = typeof payload.interactionId === "string" ? links.get(`interaction:${payload.interactionId}`) : undefined
    const request = typeof payload.requestId === "string" ? links.get(`request:${payload.requestId}`) : undefined
    const tool = typeof payload.toolUseId === "string" ? links.get(`tool:${payload.toolUseId}`) : undefined
    if (inputTypes.has(row.type) && interaction) owners.set(row.position, interaction)
    if (auditTypes.has(row.type) && request) owners.set(row.position, request)
    if (row.type.startsWith("tool.") && tool) owners.set(row.position, tool)
    if (fileTypes.has(row.type)) {
      try {
        const fact = parseFileMutationFact(envelope(row))
        const toolUseId = mutationTool(fact.payload)
        const owner = toolUseId ? links.get(`tool:${toolUseId}`) : undefined
        if (owner) {
          owners.set(row.position, owner)
          if ("operationId" in fact.payload) putLink(`operation:${fact.payload.operationId}`, owner)
          if ("mutationId" in fact.payload) putLink(`mutation:${fact.payload.mutationId}`, owner)
        }
      } catch { /* boundary: damaged linked mutation evidence is handled by its operation anchor. */ }
    }
  }
  for (const row of rows) {
    if (row instanceof CorruptEventRowError || !fileTypes.has(row.type)) continue
    const id = row.payload.operationId ?? row.payload.mutationId
    const owner = typeof id === "string" ? links.get(`${row.payload.operationId ? "operation" : "mutation"}:${id}`) : undefined
    if (owner) owners.set(row.position, owner)
  }
  // Cumulative streams are indivisible. A stream without one proven owner is residual.
  const streams = new Map<string, StoredFact[]>()
  const damagedUsage = rows.some(row => row instanceof CorruptEventRowError && budgetTypes.has(row.row.type))
  for (const row of rows) {
    if (row instanceof CorruptEventRowError || !budgetTypes.has(row.type)) continue
    const stream = typeof row.payload.budgetStreamId === "string" ? `budget:${row.payload.budgetStreamId}`
      : typeof row.payload.parentToolUseId === "string" ? `parent:${row.payload.parentToolUseId}` : "session"
    const own = streams.get(stream)
    if (own) own.push(row)
    else streams.set(stream, [row])
  }
  for (const stream of damagedUsage ? [] : streams.values()) {
    const proven = stream.filter(row => row.type === "model.usage.measured").map(row =>
      typeof row.payload.parentToolUseId === "string" ? parentTools.get(row.payload.parentToolUseId) : undefined)
    const first = proven[0]
    if (first && proven.every(owner => owner === first)) for (const row of stream) owners.set(row.position, first)
  }
  const result = new Map<string, number[]>()
  for (const [position, owner] of owners) {
    const positions = result.get(owner)
    if (positions) positions.push(position)
    else result.set(owner, [position])
  }
  return result
}

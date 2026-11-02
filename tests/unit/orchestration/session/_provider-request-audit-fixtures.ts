import type { EventStore } from "../../../../src/infra/event-store-types.js"
import {
  buildProviderRequestFacts,
  type ConversationDedup,
} from "../../../../src/orchestration/session/provider-request-audit-recorder.js"
import type { ProviderRequestAuditRequestInput } from "../../../../src/orchestration/session/provider-request-audit-types.js"

/** Seeds historical provider-request audit rows into a store. Live recording
 *  goes to the debug log only; tests for the historical projection and the
 *  reconstruction fold append the same built facts as durable rows the way
 *  older runtimes wrote them. */
export function appendProviderRequestFacts(
  store: Pick<EventStore, "append">,
  sessionId: string,
  input: Omit<ProviderRequestAuditRequestInput, "requestId"> & Partial<Pick<ProviderRequestAuditRequestInput, "requestId">>,
  dedup: ConversationDedup = {},
): string {
  const built = buildProviderRequestFacts({ ...input, requestId: input.requestId ?? crypto.randomUUID() }, dedup)
  for (const fact of built.facts) {
    store.append({
      aggregateId: `session:${sessionId}`,
      type: fact.type,
      version: fact.version,
      timestamp: Date.now(),
      actor: fact.actor,
      sessionId,
      payload: fact.payload,
    })
  }
  Object.assign(dedup, built.dedupAdvance)
  return built.requestId
}

import type { LocalSqliteEventStore } from "../../../../src/infra/substrate/store/event-store-types.js"
import {
  recordProviderRequest,
  type ConversationDedup,
} from "../../../../src/orchestration/session/diagnostics/provider-request-audit-recorder.js"
import type { ProviderRequestAuditFact } from "../../../../src/orchestration/session/runtime-facts/provider-request-audit-facts.js"
import type { ProviderRequestAuditRequestInput } from "../../../../src/orchestration/session/runtime-facts/provider-request-audit-types.js"

/** The audit facts that the live recorder records for one provider request,
 *  in record order. Advances `dedup` as the recorder does. */
export async function providerRequestFacts(input: ProviderRequestAuditRequestInput, dedup: ConversationDedup = {}): Promise<ProviderRequestAuditFact[]> {
  const facts: ProviderRequestAuditFact[] = []
  await recordProviderRequest({ observe: (fact) => facts.push(fact) }, input, dedup)
  return facts
}

/** Seeds historical provider-request audit rows into a store. Live recording
 *  goes to the debug log only; tests for the historical projection and the
 *  reconstruction fold append the same recorded facts as durable rows the way
 *  older runtimes wrote them. */
export async function appendProviderRequestFacts(
  store: Pick<LocalSqliteEventStore, "append">,
  sessionId: string,
  input: Omit<ProviderRequestAuditRequestInput, "requestId"> & Partial<Pick<ProviderRequestAuditRequestInput, "requestId">>,
  dedup: ConversationDedup = {},
): Promise<string> {
  const requestId = input.requestId ?? crypto.randomUUID()
  for (const fact of await providerRequestFacts({ ...input, requestId }, dedup)) {
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
  return requestId
}

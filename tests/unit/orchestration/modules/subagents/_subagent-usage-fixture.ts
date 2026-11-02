import { randomUUID } from "node:crypto"
import type { LocalSqliteEventStore } from "../../../../../src/infra/event-store-types.js"

export function appendUsage(store: LocalSqliteEventStore, sessionId: string, input: number, output: number, cost: number): void {
  store.append({
    aggregateId: `session:${sessionId}`,
    sessionId,
    type: "model.usage.measured",
    version: 5,
    actor: "provider",
    timestamp: Date.now(),
    payload: {
      attemptId: randomUUID(),
      occurredAt: new Date().toISOString(),
      profileId: "profile-a",
      attribution: { kind: "candidate", providerId: "openai_api" },
      spendMode: "direct_api",
      credentialLineage: randomUUID(),
      model: "gpt-5",
      tokens: { input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      classification: "real_spend",
      price: { kind: "priced", estimatedUsd: cost, rateCard: {}, provenance: "test" },
      currency: "USD",
      budgetStreamId: `stream-${sessionId}`,
    },
  })
}

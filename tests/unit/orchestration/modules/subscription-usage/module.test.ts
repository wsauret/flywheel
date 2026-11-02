import { expect, test } from "bun:test"
import { NO_MODULE_SERVICES } from "../../../../../src/infra/module-service.js"
import { asAsyncEventReadSurface } from "../../../../../src/infra/event-store-types.js"
import { subscriptionUsageModule } from "../../../../../src/orchestration/modules/subscription-usage/module.js"
import { subscriptionUsageProtocol, subscriptionUsageStatusRows } from "../../../../../src/protocol/modules/subscription-usage.js"
import { createSubscriptionUsageProtocol } from "../../../../../src/orchestration/modules/subscription-usage/protocol.js"
import { inMemoryEventReader } from "../../../../helpers/in-memory-event-reader.js"

test("usage declares five control reads, three lossless mutations, and no live domain", () => {
  expect(subscriptionUsageProtocol.domains).toEqual([])
  expect(subscriptionUsageProtocol.queries.map(({ query, deadline }) => [query, deadline])).toEqual([["usage.metadata", "control"], ["usage.stats", "control"], ["usage.accounts", "control"], ["usage.spend", "control"], ["usage.history", "control"]])
  expect(subscriptionUsageProtocol.mutations.map(({ type, policy }) => [type, policy])).toEqual([["usage.open", "lossless"], ["usage.refresh", "lossless"], ["usage.apply_reset", "lossless"]])
  expect(subscriptionUsageModule.contributions.find((entry) => entry.domain === "commands")?.value.id).toBe("usage")
  expect(subscriptionUsageStatusRows(undefined)).toEqual([])
})

test("a disabled usage module refuses queries and mutations without an accounting lease", async () => {
  // Construction captures the reader; disabled routing rejects before reading it or acquiring a service.
  const runtime = createSubscriptionUsageProtocol({ enabled: () => false, modules: NO_MODULE_SERVICES, projectionReader: asAsyncEventReadSurface(inMemoryEventReader([])) })
  await expect(runtime.serve["usage.stats"]({ type: "usage.stats", sessionId: "session" })).rejects.toThrow("Usage is off")
  await expect(runtime.serve["usage.accounts"]({ type: "usage.accounts", scope: { kind: "defaults" } })).rejects.toThrow("Usage is off")
  await expect(runtime.serve["usage.spend"]({ type: "usage.spend", scope: { kind: "defaults" } })).rejects.toThrow("Usage is off")
  await expect(runtime.serve["usage.history"]({ type: "usage.history", scope: { kind: "defaults" }, range: "24h" })).rejects.toThrow("Usage is off")
  await expect(runtime.mutate["usage.apply_reset"]({ type: "usage.apply_reset", scope: { kind: "defaults" }, sourceId: "account", authorityIncarnation: "authority", revision: 1, redeemRequestId: "request" })).resolves.toEqual({ kind: "stale" })
  await expect(runtime.mutate["usage.open"]({ type: "usage.open", scope: { kind: "defaults" } })).resolves.toEqual({ ok: false, error: "Usage is off" })
  await expect(runtime.mutate["usage.refresh"]({ type: "usage.refresh", scope: { kind: "defaults" } })).resolves.toEqual({ ok: false, error: "Usage is off" })
})

import { composeModuleServices } from "../../src/infra/module-service.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../src/infra/event-store-types.js"
import { createMemoryStore } from "../unit/workflows/vm/host-test-support.js"
import type { RuntimeAuthStatusScope } from "../../src/protocol/auth-status-protocol-types.js"
import { createFlywheelAppService, type FlywheelAppServiceDeps } from "../../src/orchestration/app-service/app-service.js"
import { composeModuleProtocolRuntimes } from "../../src/orchestration/app-service/module-protocol-host.js"
import type { SubscriptionUsageServiceLease } from "../../src/orchestration/auth/provider-observations/subscription-usage-service-pool.js"
import { subscriptionUsageModule } from "../../src/orchestration/modules/subscription-usage/module.js"
import { createUnifiedUsage, type UnifiedUsageDeps } from "../../src/orchestration/modules/subscription-usage/queries.js"
import { fakeManager, fakeSessionStore } from "../unit/orchestration/app-service/app-service-doubles.js"
import { inMemoryEventReader } from "./in-memory-event-reader.js"
import { repoDefinitions } from "./project-definitions.js"

export type UsageAppServiceDeps = FlywheelAppServiceDeps & UnifiedUsageDeps & {
  readonly subscriptionUsage?: NonNullable<UnifiedUsageDeps["subscriptionUsage"]> & {
    subscribePublications(listener: (profile: SubscriptionUsageServiceLease["profile"], scopes: readonly RuntimeAuthStatusScope[], service: SubscriptionUsageServiceLease["service"]) => void): () => void
  }
}

/** Wires the production module routes over the test's captured accounting authority. */
export function createUsageAppService(deps: UsageAppServiceDeps) {
  const modules = composeModuleServices([[subscriptionUsageModule.id, { queries: createUnifiedUsage(deps), dispose() {} }]])
  const reader = asAsyncEventReadSurface(inMemoryEventReader([]))
  const moduleProtocol = composeModuleProtocolRuntimes([subscriptionUsageModule], {
    eventWriter: asAsyncEventWriter(createMemoryStore([])),
    eventStore: reader, projectionReader: reader, sessionStore: fakeSessionStore(new Map()), definitions: repoDefinitions(),
    onStored: () => () => {}, publish: deps.bus.publish, snapshotPosition: deps.bus.snapshotPosition,
    hasLiveSession: () => false, background: async () => { throw new Error("No background usage domain") }, modules,
    interruptSession: async () => false,
    manager: fakeManager(),
  }, () => [subscriptionUsageModule.id])
  return createFlywheelAppService({ ...deps, moduleProtocol })
}

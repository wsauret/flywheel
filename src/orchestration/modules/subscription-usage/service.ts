import { configSection } from "../../config/config-section.js"
import { subscriptionUsageConfigSection } from "./config.js"
import { moduleServiceHandle } from "../../../infra/module-service.js"
import { errorMessage } from "../../../infra/error-message.js"
import { Log } from "../../../infra/log.js"
import { createOrderedLane } from "../../../infra/ordered-lane.js"
import type { ModuleProcessServices, ModuleServiceInstance } from "../../app-service/module-service-host.js"
import { createUnifiedUsage } from "./queries.js"
import { createRuntimeUsageDeps } from "./provider-deps.js"
import { createSubscriptionUsageNotificationMaterializer } from "./notification-materializer.js"

const log = Log.create({ service: "subscription-usage" })
export interface SubscriptionUsageModuleService extends ModuleServiceInstance {
  readonly queries: ReturnType<typeof createUnifiedUsage>
}
export const subscriptionUsageService = moduleServiceHandle<SubscriptionUsageModuleService>("subscription-usage")

type Accounting = ReturnType<ModuleProcessServices["profileAccounting"]>
type UsageServicePorts = Pick<ModuleProcessServices, "config" | "enabled" | "configView" | "moduleSelection" | "onSelectionChanged" | "notify" | "interactive"> & {
  readonly directories: Pick<ModuleProcessServices["directories"], "projectRoot">
  readonly projectionReader: Pick<ModuleProcessServices["projectionReader"], "hasInFlightProfile">
  readonly profileAccounting: () => {
    readonly subscriptionUsage: Pick<Accounting["subscriptionUsage"], "acquireScope" | "subscribePublications" | "start" | "pause" | "replaceThresholds">
    readonly refreshSubscriptionSpendConsent: Accounting["refreshSubscriptionSpendConsent"]
  }
}

/** Optional inspection, polling, and threshold notices over the kernel's
 *  profile accounting authority. Turning this service off preserves request
 *  settlement and the provider evidence admission consumes. */
export function createSubscriptionUsageService(services: UsageServicePorts): SubscriptionUsageModuleService {
  const accounting = services.profileAccounting
  const providerDeps = createRuntimeUsageDeps({ moduleSelection: services.moduleSelection, eventReader: services.projectionReader })
  const queries = createUnifiedUsage({
    ...providerDeps,
    subscriptionUsage: { acquireScope: (scope) => accounting().subscriptionUsage.acquireScope(scope) },
    refreshSubscriptionSpendConsent: (scope, service) => accounting().refreshSubscriptionSpendConsent(scope, service),
    config: { view: services.configView },
  })
  const materializer = createSubscriptionUsageNotificationMaterializer({
    notify: services.notify,
    projectRoot: services.directories.projectRoot,
    owner: `runtime:${process.pid}`,
    providerName: (providerId) => providerDeps.usageProviderDisplayName(providerId),
    log,
  })
  const unsubscribe: (() => void | Promise<void>)[] = []
  let started = false
  let accepting = true
  const transitions = createOrderedLane()
  let stopping: Promise<void> = Promise.resolve()
  const follow = (): Promise<void> => {
    if (!started || !accepting) return Promise.resolve()
    const pool = accounting().subscriptionUsage
    const enabled = services.enabled()
    if (!enabled) pool.pause()
    return transitions.run(async () => {
      if (!accepting) return
      await pool.replaceThresholds(enabled ? configSection(services.config.snapshot().config, subscriptionUsageConfigSection).alert_thresholds : [])
      if (enabled && services.enabled() && accepting && services.interactive) pool.start()
    })
  }
  return {
    queries,
    start() {
      if (started || !accepting) return
      started = true
      unsubscribe.push(services.onSelectionChanged(follow), services.config.subscribe(subscriptionUsageConfigSection, follow), accounting().subscriptionUsage.subscribePublications((_profile, _scopes, service) => {
        if (!accepting || !services.enabled()) return
        const generation = service.generation()
        const store = service.store()
        if (!generation || !store) return
        for (const account of generation.accounts) if (account.identity !== undefined) {
          void materializer.materializePending(store, account).catch((error: unknown) => log.warn("usage alert materialization failed", { error: errorMessage(error) }))
        }
      }))
      void follow().catch((error: unknown) => log.warn("usage monitoring start failed", { error: errorMessage(error) }))
    },
    closeAdmission() {
      accepting = false
      stopping = Promise.all([stopping, ...unsubscribe.splice(0).map((stop) => stop())]).then(() => {})
      // A composition that fails before its auth runtime exists closes a
      // service that never started, and then no accounting exists to read.
      if (started) accounting().subscriptionUsage.pause()
      materializer.closeAdmission()
    },
    async dispose() {
      this.closeAdmission?.()
      await transitions.settled()
      await stopping.catch(() => {})
      await materializer.settled()
    },
  }
}

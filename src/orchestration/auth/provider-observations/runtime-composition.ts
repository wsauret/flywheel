import { errorDetail, errorMessage } from "../../../infra/error-message.js"
import { Log } from "../../../infra/log.js"
import { createSubscriptionUsageService, type SubscriptionUsageProfile } from "./subscription-usage-service.js"
import { createSubscriptionUsageServicePool, type SubscriptionUsageServicePool } from "./subscription-usage-service-pool.js"
import { peekSharedProviderAvailability } from "../../agent-runtime/llm/shared-provider-availability.js"
import { foldSubscriptionUsageIntoAvailability } from "./usage-availability-fold.js"

import type { AccessProviderRegistry } from "../../agent-runtime/llm/access-provider-registry.js"
import type { LauncherScope } from "../../../infra/process-supervisor.js"
const log = Log.create({ service: "runtime-composition" })

interface UsageOwnership {
  own<T>(name: string, resource: T, dispose: (owned: T) => Promise<void> | void): T
}

export interface SubscriptionUsageRuntimeOptions {
  readonly own: UsageOwnership["own"]
  readonly registry: () => AccessProviderRegistry
  readonly thresholds: () => readonly number[]
  readonly monitor: boolean
  readonly onCapabilitiesChanged: (listener: () => void) => () => void
  /** The runtime's launch authority, for a usage reader that asks a program that owns the login. */
  readonly launcher?: LauncherScope
}

export function createSubscriptionUsageRuntime(options: SubscriptionUsageRuntimeOptions): SubscriptionUsageServicePool {
  const pool = options.own("provider-observations", createSubscriptionUsageServicePool({
    thresholds: options.thresholds(),
    create: (profile: SubscriptionUsageProfile, thresholds) => createSubscriptionUsageService({
      profile: () => profile,
      registry: options.registry,
      thresholds: () => thresholds,
      monitor: options.monitor,
      ...(options.launcher === undefined ? {} : { launcher: options.launcher }),
    }),
  }), (servicePool) => { servicePool.closeAdmission(); return servicePool.settled() })
  // Publications start after the composition acquires the availability owner; a
  // publication before that has no authority to reach and states nothing.
  options.own("provider-observations-availability-fold", pool.onPublished((_profile, service) => {
    const owner = peekSharedProviderAvailability()
    const snapshot = service.snapshot()
    if (owner !== undefined && snapshot !== undefined) foldSubscriptionUsageIntoAvailability(owner, snapshot)
  }), (unsubscribe) => { unsubscribe() })
  options.own("provider-observations-capability-subscription", options.onCapabilitiesChanged(() => {
    void pool.refresh().catch((err: unknown) => {
      log.warn("subscription usage generation refresh failed", { error: errorMessage(err), errorDetail: errorDetail(err) })
    })
  }), (unsubscribe) => { unsubscribe() })
  return pool
}

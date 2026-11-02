import { recordBackgroundFailure } from "../../infra/operation-log.js"
import { Log } from "../../infra/log.js"
import { createOrderedLane } from "../../infra/ordered-lane.js"
import type { RuntimeAuthStatusScope } from "../../protocol/auth-status-protocol-types.js"
import type { AuthProfileResolution } from "../auth/auth-profile-manager.js"
import type { SubscriptionUsageServiceLease, SubscriptionUsageServicePool } from "../auth/provider-observations/subscription-usage-service-pool.js"
import type { SessionManager } from "../session/manager.js"
import { resolveSessionAuthProfile, sessionAuthFacts, type ResidentSessionAuthFacts, type WorkflowAuthRuns } from "./auth-profile-scope.js"

const log = Log.create({ service: "auth-runtime" })

/** Holds active session usage leases and serializes background reconciliation.
 * The caller marks disposal before joining settlement and releasing the leases. */
export function createResidentAuthScopes(options: {
  readonly manager: Pick<SessionManager, "read">
  readonly runs: WorkflowAuthRuns
  readonly userDataRoot: string
  readonly currentProfile: () => AuthProfileResolution
  readonly resolveProfile: (scope: RuntimeAuthStatusScope) => Promise<AuthProfileResolution>
  readonly disposed: () => boolean
  readonly pool: SubscriptionUsageServicePool
}) {
  type ResidentScope = RuntimeAuthStatusScope | { readonly kind: "workflow"; readonly workflowId: string }
  const leases = new Map<string, { readonly scope: ResidentScope; readonly lease: SubscriptionUsageServiceLease }>()
  const subscriptionUsage = Object.assign(options.pool, {
    acquireScope: async (scope: RuntimeAuthStatusScope) => {
      const resolved = await options.resolveProfile(scope)
      return options.pool.acquire({ id: resolved.id, directory: resolved.directory })
    },
    subscribePublications: (listener: (profile: SubscriptionUsageServiceLease["profile"], scopes: readonly RuntimeAuthStatusScope[], service: SubscriptionUsageServiceLease["service"]) => void) => options.pool.onPublished((profile, service) => {
      const scopes: RuntimeAuthStatusScope[] = []
      for (const resident of leases.values()) {
        if (resident.scope.kind !== "workflow" && resident.lease.profile.id === profile.id && resident.lease.profile.directory === profile.directory) scopes.push(resident.scope)
      }
      if (scopes.length > 0) listener(profile, scopes, service)
    }),
  })
  const reconciliations = createOrderedLane()
  // Catalog rows avoid one state Worker round trip per active session at startup.
  const reconcile = async (scope: RuntimeAuthStatusScope, session?: ResidentSessionAuthFacts | null): Promise<void> => {
    if (options.disposed()) return
    const key = scope.kind === "defaults" ? "defaults" : `session:${scope.sessionId}`
    const previous = leases.get(key)?.lease
    const facts = scope.kind === "session" && session === undefined ? await options.manager.read(scope.sessionId) : session
    // Missing or inactive sessions, and sessions whose profile this account
    // lacks, release their lease without acquiring another.
    const defaults = options.currentProfile()
    const selected = facts?.lifecycleState === "active"
      ? resolveSessionAuthProfile(await sessionAuthFacts(facts, options.runs), defaults, options.userDataRoot)
      : undefined
    const resolved = scope.kind === "defaults"
      ? defaults
      : defaults.availableProfiles.some(({ id }) => id === selected?.id) ? selected : undefined
    if (previous && resolved && previous.profile.id === resolved.id && previous.profile.directory === resolved.directory) return
    if (previous) {
      leases.delete(key)
      await previous.release()
    }
    if (!resolved || options.disposed()) return
    leases.set(key, { scope, lease: await options.pool.acquire({ id: resolved.id, directory: resolved.directory }) })
  }
  // A failed read retains the previous lease; a failed release or acquisition
  // leaves none. Later scopes proceed, and only a later session change retries.
  const enqueue = (scopes: readonly RuntimeAuthStatusScope[]): void => {
    void reconciliations.run(async () => {
      for (const scope of scopes) {
        try {
          await reconcile(scope)
        } catch (error) {
          recordBackgroundFailure(log, "resident subscription usage reconciliation", { scope: scope.kind, sessionId: scope.kind === "session" ? scope.sessionId : undefined }, error)
        }
      }
    })
  }
  const reconcileWorkflow = async (workflowId: string, profile: AuthProfileResolution | undefined): Promise<void> => {
    const key = `workflow:${workflowId}`
    const previous = leases.get(key)?.lease
    if (previous && profile && previous.profile.id === profile.id && previous.profile.directory === profile.directory) return
    if (previous) { leases.delete(key); await previous.release() }
    if (profile && !options.disposed()) leases.set(key, { scope: { kind: "workflow", workflowId }, lease: await options.pool.acquire({ id: profile.id, directory: profile.directory }) })
  }
  const reconcileWorkflows = (rows: readonly { readonly workflowId: string; readonly profile: AuthProfileResolution }[]): Promise<void> => reconciliations.run(async () => {
    const current = new Set(rows.map(({ workflowId }) => workflowId))
    for (const { scope } of leases.values()) if (scope.kind === "workflow" && !current.has(scope.workflowId)) await reconcileWorkflow(scope.workflowId, undefined)
    for (const { workflowId, profile } of rows) await reconcileWorkflow(workflowId, profile)
  })
  return { leases, subscriptionUsage, reconcile, reconcileWorkflows, enqueue, settled: reconciliations.settled }
}

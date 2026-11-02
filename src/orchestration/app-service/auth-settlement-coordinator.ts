import type { AuthOperationNotice, RuntimeAuthStatusScope } from "../../protocol/auth-status-protocol-types.js"

interface AuthSettlementCoordinatorOptions {
  readonly refreshConfig: () => Promise<void>
  readonly refreshProfile: (profileId: string, signal: AbortSignal) => Promise<void>
  /** Every scope one profile currently backs, answered from one catalog read. */
  readonly profileScopes: (profileId: string) => Promise<readonly RuntimeAuthStatusScope[]>
  readonly publish: (scopes: readonly RuntimeAuthStatusScope[], notice: AuthOperationNotice) => Promise<void>
}

/** Coordinates supersession and publication for in-flight auth mutations. */
export function createAuthSettlementCoordinator(options: AuthSettlementCoordinatorOptions) {
  const controllers = new Map<string, AbortController>()
  const profiles = new Map<string, AbortController>()
  const operations = new Map<string, Promise<void>>()

  const settle = async (profileId: string, operationId: string): Promise<void> => {
    profiles.get(profileId)?.abort(new DOMException("Auth settlement superseded", "AbortError"))
    controllers.get(operationId)?.abort(new DOMException("Auth settlement superseded", "AbortError"))
    const controller = new AbortController()
    controllers.set(operationId, controller)
    profiles.set(profileId, controller)
    const operation = (async () => {
      await options.refreshConfig()
      await options.refreshProfile(profileId, controller.signal)
    })()
    operations.set(operationId, operation)
    try {
      await operation
    } finally {
      if (controllers.get(operationId) === controller) controllers.delete(operationId)
      if (profiles.get(profileId) === controller) profiles.delete(profileId)
      if (operations.get(operationId) === operation) operations.delete(operationId)
    }
  }

  return {
    settle,
    /** Publishes a login's progress or end on every scope the profile backs. */
    async publish(profileId: string, notice: AuthOperationNotice): Promise<void> {
      await options.publish(await options.profileScopes(profileId), notice)
    },
    async dispose(): Promise<void> {
      for (const controller of controllers.values()) controller.abort(new DOMException("Auth runtime disposed", "AbortError"))
      await Promise.allSettled(operations.values())
    },
  }
}

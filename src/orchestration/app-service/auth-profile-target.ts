import type { AuthProfileManager, AuthProfileResolution } from "../auth/auth-profile-manager.js"
import type { RuntimeAuthProfileWriteScope } from "../../protocol/auth-profile-selection-protocol-types.js"
import type { SessionAuthAdmission } from "../session/session-auth-profile.js"
import type { SessionStore } from "../session-store/types.js"
import type { WorkflowHosts } from "../workflow-host/host-collection.js"
import type { AuthStatusProjection } from "./auth-status-projection.js"

/** Prepares a selected profile and publishes its new request capture without persisting resolved roles. */
export async function prepareAuthProfileTarget(input: {
  readonly profileId: string
  readonly prepare: () => Promise<void>
  readonly profiles: Pick<AuthProfileManager, "resolve">
  readonly projection: Pick<AuthStatusProjection, "replace">
  readonly setCurrent: (profile: AuthProfileResolution) => void
  readonly refreshResidentDefaults: () => Promise<void>
  readonly refreshUsage: () => Promise<void>
  readonly admission: Pick<SessionAuthAdmission<never>, "invalidate">
  readonly sessions: Pick<SessionStore, "refreshDeps">
  readonly workflows: Pick<WorkflowHosts, "refreshDeps">
  readonly publish: () => Promise<void>
}) {
  await input.prepare()
  return {
    roles: {},
    async publish(scope: RuntimeAuthProfileWriteScope): Promise<void> {
      const invalidated = input.admission.invalidate(input.profileId)
      if (scope.kind === "session") {
        await input.sessions.refreshDeps([...new Set([scope.sessionId, ...invalidated])])
        await input.workflows.refreshDeps()
        return
      }
      const resolved = await input.profiles.resolve()
      if (resolved.id === input.profileId) {
        input.projection.replace(resolved)
        input.setCurrent(resolved)
        await input.refreshResidentDefaults()
        await input.refreshUsage()
      }
      await Promise.all([input.sessions.refreshDeps(), input.workflows.refreshDeps()])
      await input.publish()
    },
  }
}

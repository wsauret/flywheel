import type { AttachedRuntimeClient } from "../../protocol/app-service-types.js"
import { authStatusCursor, type RuntimeAuthStatusScope, type RuntimeAuthView } from "../../protocol/auth-status-protocol-types.js"
import { createHeldView } from "../../protocol/client/held-view.js"

/** Seeds scoped auth before saved-row reads and observes later publications. No provider discovery is awaited. Dispose on close or scope change. */
export function observeModelCatalog(
  client: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">,
  scope: RuntimeAuthStatusScope,
  published: (auth: RuntimeAuthView) => void,
) {
  let revision: string | undefined
  const held = createHeldView<RuntimeAuthView>({
    client,
    cursor: authStatusCursor(scope),
    read: async () => {
      const snapshot = await client.query({ type: "authStatusSnapshot", scope })
      return { view: snapshot.auth, position: snapshot.snapshotPosition }
    },
    adopt: (payload) => (payload.kind === "auth.changed" ? payload.auth : undefined),
    changed: (auth) => {
      const next = `${auth.profile.id}:${auth.autoEnableNewModels?.eligibilityRevision}`
      if (next === revision) return
      revision = next
      published(auth)
    },
    label: "model catalog auth",
  })
  return { ready: held.ready, dispose: held.dispose }
}

import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { createHeldView, type HeldViewSource } from "../../../src/protocol/client/held-view.js"
import { providerSetup, type ProviderSetup } from "../../../src/protocol/client/provider-setup.js"
import { summarizeProviders, type ProviderSummary } from "../../../src/protocol/client/provider-summary.js"
import { authStatusCursor, type RuntimeAuthStatusScope, type RuntimeAuthStatusSnapshotResult } from "../../../src/protocol/auth-status-protocol-types.js"

/** The runtime's auth snapshot, held live on its scoped `auth` cursor:
 *  accounts, the profile, paid-use consent, the settlement of the last login,
 *  and the position a consent write must echo. The sheets that manage
 *  providers read the snapshot; the panel reads the provider summary cut from
 *  it. The held view reads it on each lane and replaces it on each patch. */
export interface AuthMonitor {
  readonly status: RuntimeAuthStatusSnapshotResult | undefined
  readonly providers: readonly ProviderSummary[]
  /** Whether any model provider is usable, by the one shared rule. Unknown
   *  is not the same as none: a setup screen shown because the first read has
   *  not answered yet would flash at every user on every open. */
  readonly providerSetup: ProviderSetup
  /** Settles once the first read has answered or failed. */
  readonly ready: Promise<void>
  /** Reads the snapshot again now, as after a write this client made. */
  refresh(): Promise<void>
  dispose(): void
}

export function createAuthMonitor(deps: {
  readonly connection: Pick<RuntimeConnection, "query" | "subscribe" | "onLane">
  readonly scope?: RuntimeAuthStatusScope
  readonly changed: (source: HeldViewSource) => void
}): AuthMonitor {
  let providers: readonly ProviderSummary[] = []
  const held = createHeldView<RuntimeAuthStatusSnapshotResult>({
    client: deps.connection,
    cursor: authStatusCursor(deps.scope),
    read: async () => {
      const view = await deps.connection.query({ type: "authStatusSnapshot", scope: deps.scope ?? { kind: "defaults" } })
      return { view, position: view.snapshotPosition }
    },
    adopt: (payload, position) => (payload.kind === "auth.changed" ? { auth: payload.auth, snapshotPosition: position } : undefined),
    changed(view, source) {
      providers = summarizeProviders(view.auth)
      deps.changed(source)
    },
    label: "provider status",
  })

  return {
    get status() { return held.view },
    get providers() { return providers },
    get providerSetup() { return providerSetup(held.view?.auth) },
    ready: held.ready,
    refresh: held.refresh,
    dispose: held.dispose,
  }
}

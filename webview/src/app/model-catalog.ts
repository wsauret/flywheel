import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import type { RuntimeAuthStatusScope, RuntimeAuthStatusSnapshotResult } from "../../../src/protocol/auth-status-protocol-types.js"
import { createAuthMonitor } from "../client/auth-monitor.js"
import { describeFailure } from "../client/failure-message.js"
import { useClient } from "./client-context.js"

/** Seeds the scoped local auth cursor before saved reads, then schedules background discovery.
 * An undefined revision means the current scope has not supplied its initial snapshot. */
export function createModelCatalogRevision(scope: Accessor<RuntimeAuthStatusScope>): Accessor<string | undefined> {
  const client = useClient()
  const [status, setStatus] = createSignal<{ key: string | undefined; snapshot: RuntimeAuthStatusSnapshotResult }>()
  const key = createMemo(() => {
    const current = scope()
    return current.kind === "session" ? current.sessionId : undefined
  })
  createEffect(on(key, () => {
    const current = scope()
    const scopeKey = key()
    let active = true
    setStatus(undefined)
    const monitor = createAuthMonitor({
      connection: client.connection,
      scope: current,
      changed: () => {
        const snapshot = monitor.status
        if (snapshot !== undefined) setStatus({ key: scopeKey, snapshot })
      },
    })
    // Seed before discovery can publish so its first revision is observable.
    void monitor.ready.then(() => {
      if (active) return client.connection.dispatch({ type: "auth.catalog.refresh", scope: current })
    }).catch((cause: unknown) => {
      if (active) client.report("warning", `Flywheel could not refresh models: ${describeFailure(cause)}`)
    })
    onCleanup(() => { active = false; monitor.dispose() })
  }))
  return createMemo(() => {
    const held = status()
    const auth = held?.key === key() ? held?.snapshot.auth : undefined
    return auth === undefined ? undefined : `${auth.profile.id}:${auth.autoEnableNewModels?.eligibilityRevision}`
  })
}

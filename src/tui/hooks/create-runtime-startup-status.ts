import { createSignal, onCleanup } from "solid-js"
import type { AttachedRuntimeClient, RuntimeStartupStatus } from "../../protocol/app-service-types.js"

/**
 * The load screen's view of blocking runtime startup work. Anything that
 * blocks the load path must reach the user as a notice with progress, and a
 * runtime that dies before serving RPC must fail the load screen loudly
 * instead of leaving a spinner behind an empty viewport.
 *
 * Like create-workspace-connection-state.ts, this is a plain top-level event
 * listener, not an ordered-patch receiver: `runtime.startup` is
 * transport-local (synthesized by the socket client from the runtime's
 * stdout handshake records), so there is no domain snapshot to reconcile.
 * A lane that opens clears the status: it supersedes both a phase notice
 * and a failure, because the client re-runs find-or-start before its next
 * dial and a later attempt can succeed.
 */
export function createRuntimeStartupStatus(deps: { appService: Pick<AttachedRuntimeClient, "subscribe" | "onLane"> }): () => RuntimeStartupStatus | null {
  const [status, setStatus] = createSignal<RuntimeStartupStatus | null>(null)

  const unsubscribe = deps.appService.subscribe((event) => {
    if (event.type === "runtime.startup") {
      // The first failure of an attempt wins: it carries the composition's
      // own error, and a later attach that fails on the dial would replace it
      // with a connection-shaped one. A fresh phase notice resets the slate.
      setStatus((previous) => previous?.kind === "failed" && event.status.kind === "failed" ? previous : event.status)
    }
  })
  const stopLanes = deps.appService.onLane(() => setStatus(null))
  onCleanup(() => { stopLanes(); unsubscribe() })

  return status
}

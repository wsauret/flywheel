import { createSignal, onCleanup } from "solid-js"
import type { RuntimeClient, RuntimeTransportHealth } from "../../protocol/app-service-types.js"

/**
 * Whether the runtime answers this terminal, as the connection reports it
 * through the transport-local `runtime.health` event. Recovery from a dropped
 * connection is not a state here: the connection reattaches and reseeds on
 * its own and stays healthy while it does, so nothing below ever renders it.
 * A fault is the one thing shown, and the connection clears it when the
 * runtime answers again. Like the startup
 * status, this is a plain top-level event listener, not an ordered-patch
 * receiver: there is no domain snapshot to reconcile.
 */
export function createRuntimeHealth(deps: { appService: Pick<RuntimeClient, "subscribe"> }): () => RuntimeTransportHealth {
  const [health, setHealth] = createSignal<RuntimeTransportHealth>({ kind: "healthy" })
  const unsubscribe = deps.appService.subscribe((event) => {
    if (event.type === "runtime.health") setHealth(event.health)
  })
  onCleanup(unsubscribe)
  return health
}

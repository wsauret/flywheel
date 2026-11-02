import type { RuntimeConnection } from "../../../../src/protocol/client/connection.js"
import type { RuntimeRemoteView } from "../../../../src/protocol/modules/remote.js"
import type { HostCapabilities } from "../../host.js"

/** Notifications for this device, as the client offers them.
 *
 *  Three parties meet here and none of them may learn the others' business:
 *  the host holds the browser's push subscription, the runtime holds the VAPID
 *  key and the list of devices to notify, and the client only carries the
 *  subscription from one to the other, on request or to repair registration. */

export type PushOutcome =
  | { readonly kind: "on" }
  | { readonly kind: "declined" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "rejected"; readonly message: string }

/** Turns notifications on: asks the browser, then hands the subscription to
 *  the runtime, which seals every push to it from then on. */
export async function enablePush(connection: RuntimeConnection, capabilities: HostCapabilities, remote: RuntimeRemoteView, signal: AbortSignal): Promise<PushOutcome> {
  if (signal.aborted) return { kind: "cancelled" }
  if (capabilities.canMutate?.("remote.push.subscribe") === false) return { kind: "rejected", message: "This host cannot change notifications." }
  const push = capabilities.push
  const device = capabilities.remote
  if (!push || !device || remote.pushPublicKey === null) return { kind: "rejected", message: "This host cannot receive notifications." }
  const subscription = await push.subscribe(remote.pushPublicKey, device.snapshot().selected?.runtimeId)
  if (signal.aborted) return { kind: "cancelled" }
  if (!subscription) return { kind: "declined" }
  const { endpoint, expirationTime, keys } = subscription
  const result = await connection.dispatch({ type: "remote.push.subscribe", deviceId: device.deviceId, subscription: { endpoint, expirationTime, keys } })
  if (signal.aborted) return { kind: "cancelled" }
  return result.kind === "committed" ? { kind: "on" } : { kind: "rejected", message: result.message }
}


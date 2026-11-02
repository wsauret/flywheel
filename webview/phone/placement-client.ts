import type { ClientHandle, RemoteHostCapability } from "../src/host.js"
import type { RelayHost } from "./relay-host.js"
import type { NotificationAddress } from "../../src/protocol/modules/remote/notification-address.js"

/** The client for the placement the person chose. One mount serves one
 *  project: a choice of another placement disposes the mount and mounts a
 *  fresh client, so the loading screen, named by the new project, shows at
 *  once and no session of the project left behind stays on screen under the
 *  new name. Choosing the same placement again keeps the client and asks it
 *  only to make sure it is connected: a working lane stays open and nothing
 *  is read again (PI-REMOTE-007), and a lane that is down or waiting out a
 *  backoff attaches at once, so a start that failed is tried again. */
export interface PlacementClient {
  /** The client on screen now. */
  readonly handle: ClientHandle
  openAddress(address: NotificationAddress): void
}

/** `address` is the session the page's address names. Only the first client
 *  opens it: a client for another project must not open a session of this
 *  one. */
export function mountPerPlacement(relay: Pick<RelayHost, "onSelectionChange"> & { readonly capability: Pick<RemoteHostCapability, "select"> }, mount: (initialSessionId?: string, attention?: boolean) => ClientHandle, initialAddress?: NotificationAddress): PlacementClient {
  let pending: NotificationAddress | undefined
  let handle = mount(initialAddress?.sessionId, initialAddress?.attention)
  const open = (address: NotificationAddress) => handle.command({ type: address.attention ? "attendQuestion" : "selectSession", sessionId: address.sessionId })
  relay.onSelectionChange((placementChanged) => {
    const addressed = pending
    pending = undefined
    if (!placementChanged) {
      handle.command({ type: "ensureConnected" })
      if (addressed) open(addressed)
      return
    }
    handle.dispose()
    handle = mount(addressed?.sessionId, addressed?.attention)
  })
  return {
    get handle() { return handle },
    openAddress(address) {
      if (!address.selection) { open(address); return }
      pending = address
      relay.capability.select(address.selection)
      // The first project choice resolves the waiting socket without a
      // selection-change callback: no old project needs to be unmounted.
      if (pending) { pending = undefined; open(address) }
    },
  }
}

import type { DeviceStore, PairedRuntime } from "../../src/protocol/modules/remote/relay-device.js"
import type { NotificationAddress } from "../../src/protocol/modules/remote/notification-address.js"
import { chooseClient, readLastClient, writeLastClient, type ClientSource, type KnownRuntime } from "./client-choice.js"

/** What the hosted page does when it loads, and again after it pairs: pair
 *  from a link when the URL carries one, otherwise load the client a paired
 *  machine serves, otherwise show the pairing screen. The page's DOM and
 *  network calls are effects passed in, so the order is testable without a
 *  browser. */

/** How long the page asks the relay which client the preferred machine
 *  serves before it chooses from what it already knows: short when this
 *  phone has loaded a client before and the browser likely holds it, long
 *  when there is nothing else to load or a machine was just paired, because
 *  a new machine attaches its projects to the relay in that time. */
const CURRENT_WAIT_MS = 3_000
const FIRST_CURRENT_WAIT_MS = 30_000

/** What the pairing screen shows and does. */
export interface PairingRequest {
  /** A code from the page's link, which the screen pairs from at once. */
  readonly code: string | undefined
  /** Set when this phone pairs with machines but none could load: they are
   *  asleep or offline. `machine` names the one the page tried, when known. */
  readonly unreachable: { readonly machine: string | undefined } | undefined
  /** Pairs from a code, keeps the machine, calls `paired` with its label,
   *  and starts the page again with it. Rejects with a message for the person
   *  when pairing fails. */
  pair(code: string, paired: (label: string) => void): Promise<void>
}

export interface PageStartEffects {
  readonly store: DeviceStore
  readonly storage: Pick<Storage, "getItem" | "setItem">
  /** The pairing code the page URL carries, removed from the URL so that a
   *  reload does not pair again. */
  takePairingCode(): string | undefined
  readonly notificationAddress?: () => NotificationAddress | undefined
  /** Which client each paired machine's relay names, waiting up to `waitMs`
   *  for the relay to name one for the preferred machine. */
  currentClients(paired: readonly PairedRuntime[], preferred: string | undefined, waitMs: number): Promise<KnownRuntime[]>
  pairDevice(code: string): Promise<PairedRuntime>
  /** Resolves once the client's phone shell ran, and rejects when the relay
   *  could not serve it. */
  loadShell(source: ClientSource): Promise<void>
  showPairing(request: PairingRequest): void
}

export function createPageStart(effects: PageStartEffects) {
  const { store, storage } = effects

  /** `justPaired` is the machine a pairing on this page just added. */
  async function start(justPaired?: string): Promise<void> {
    // A link is a request to pair, whatever this phone already pairs with
    // (PI-REMOTE-001), so it goes first and waits on no relay.
    const code = effects.takePairingCode()
    if (code !== undefined) return effects.showPairing({ code, unreachable: undefined, pair })
    const paired = await store.runtimes()
    if (paired.length === 0) return effects.showPairing({ code: undefined, unreachable: undefined, pair })
    const addressed = effects.notificationAddress?.()?.selection
    if (addressed && paired.some((runtime) => runtime.runtimeId === addressed.runtimeId)) await store.setSelection(addressed)
    const preferred = justPaired ?? (await store.selection())?.runtimeId
    const lastLoaded = readLastClient(storage)
    const waitMs = justPaired !== undefined || lastLoaded === undefined ? FIRST_CURRENT_WAIT_MS : CURRENT_WAIT_MS
    const choice = chooseClient({ runtimes: await effects.currentClients(paired, preferred, waitMs), preferred, lastLoaded })
    if (choice.kind === "load") {
      const chosen: ClientSource = { runtimeId: choice.runtimeId, relay: choice.relay, identity: choice.identity }
      const candidates = [chosen, ...(lastLoaded !== undefined && lastLoaded.identity !== chosen.identity && paired.some((runtime) => runtime.runtimeId === lastLoaded.runtimeId) ? [lastLoaded] : [])]
      for (const source of candidates) {
        try {
          await effects.loadShell(source)
          writeLastClient(storage, source)
          return
        } catch {
          // A relay that has never seen this identity and reaches no machine
          // that serves it: the next candidate may still be in this browser's
          // cache.
        }
      }
    }
    // Every paired machine is asleep or offline, as far as this page can
    // tell, so the person sees how to pair rather than a dead end
    // (PI-REMOTE-010). A phone with one saved machine and no selection
    // still names that machine.
    const tried = choice.kind === "load" ? choice.runtimeId : preferred ?? (paired.length === 1 ? paired[0]?.runtimeId : undefined)
    effects.showPairing({ code: undefined, unreachable: { machine: paired.find((runtime) => runtime.runtimeId === tried)?.label }, pair })
  }

  async function pair(code: string, paired: (label: string) => void): Promise<void> {
    const runtime = await effects.pairDevice(code)
    await store.putRuntime(runtime)
    paired(runtime.label)
    // The project the phone last opened is on another machine. The person
    // asked for this one, so the client opens on its machines list, where
    // this machine's projects are, and not on the other machine's project.
    const selection = await store.selection()
    if (selection !== undefined && selection.runtimeId !== runtime.runtimeId) await store.setSelection(undefined)
    await start(runtime.runtimeId)
  }

  return { start: () => start() }
}

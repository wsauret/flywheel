import { CLIENT_IDENTITY_PATTERN } from "../../src/protocol/client-identity.js"
import { decodeCurrentClient } from "../../src/protocol/modules/remote/relay-protocol.js"

/** Which client build the hosted page loads, and where from.
 *
 *  The page loads the client a machine serves, through that machine's relay,
 *  under the identity the relay names for it at `/client/<runtimeId>/current`:
 *  the identity a live placement of that machine announces, or the one the
 *  relay kept when it last served that machine. Presence never carries it,
 *  because presence keeps the shape phones already decode. The preferred
 *  machine (the one just paired, else the selected project's machine)
 *  decides when the relay names one; while it does not, the client this
 *  phone last loaded from it; then whatever the relay names for another
 *  paired machine; then the last client this phone loaded from any machine
 *  it still pairs with, which the browser's own cache may still hold. A
 *  client that turns out to be the wrong one for the selected machine is
 *  refused at its first attach and the page loads again, so a fallback costs
 *  one reload, never a wrong session. */

/** One paired machine as the page knows it: `current` is the identity its
 *  relay names, or undefined while the relay has named none. */
export interface KnownRuntime {
  readonly runtimeId: string
  readonly relay: string
  readonly current: string | undefined
}

export interface ClientSource {
  readonly runtimeId: string
  readonly relay: string
  readonly identity: string
}

export type ClientChoice =
  | ({ readonly kind: "load" } & ClientSource)
  /** Nothing to load: no machine is paired, or the relay names no client for
   *  any paired machine and this phone loaded none before, which is what an
   *  asleep or offline machine looks like. The page shows its pairing screen
   *  (PI-REMOTE-010). */
  | { readonly kind: "pair" }

export function chooseClient(input: { readonly runtimes: readonly KnownRuntime[]; readonly preferred: string | undefined; readonly lastLoaded: ClientSource | undefined }): ClientChoice {
  const load = (runtime: KnownRuntime, identity: string): ClientChoice => ({ kind: "load", runtimeId: runtime.runtimeId, relay: runtime.relay, identity })
  const selected = input.runtimes.find((runtime) => runtime.runtimeId === input.preferred)
  const last = input.lastLoaded
  const lastRuntime = input.runtimes.find((runtime) => runtime.runtimeId === last?.runtimeId)
  if (selected) {
    if (selected.current !== undefined) return load(selected, selected.current)
    if (last && lastRuntime === selected) return load(selected, last.identity)
  }
  for (const runtime of input.runtimes) {
    if (runtime.current !== undefined) return load(runtime, runtime.current)
  }
  if (last && lastRuntime) return load(lastRuntime, last.identity)
  return { kind: "pair" }
}

/** Asks a machine's relay which client that machine serves. Nothing when the
 *  relay names none (503), answers something that is not an identity, or
 *  cannot be reached. */
export async function currentClient(relay: string, runtimeId: string, fetcher: (url: string) => Promise<Response>): Promise<string | undefined> {
  try {
    const response = await fetcher(`${assetOrigin(relay)}/client/${runtimeId}/current`)
    if (!response.ok) return undefined
    return decodeCurrentClient(await response.json()).identity
  } catch {
    return undefined
  }
}

/** Where a relay serves client files: its own origin over HTTP. */
export function assetOrigin(relay: string): string {
  const url = new URL(relay)
  url.protocol = url.protocol === "ws:" ? "http:" : "https:"
  return url.origin
}

/** The last client this phone loaded, kept in `localStorage` under a version.
 *  A value of another version, or one that does not read, is ignored and the
 *  page starts plain; a storage that refuses is the same as an empty one. */
const LAST_CLIENT_KEY = "flywheel.phone.last-client"
const LAST_CLIENT_VERSION = 1

export function readLastClient(storage: Pick<Storage, "getItem">): ClientSource | undefined {
  let value: unknown
  try {
    value = JSON.parse(storage.getItem(LAST_CLIENT_KEY) ?? "null")
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null || !("v" in value) || value.v !== LAST_CLIENT_VERSION) return undefined
  if (!("runtimeId" in value) || typeof value.runtimeId !== "string" || !("relay" in value) || typeof value.relay !== "string") return undefined
  if (!("identity" in value) || typeof value.identity !== "string" || !CLIENT_IDENTITY_PATTERN.test(value.identity)) return undefined
  return { runtimeId: value.runtimeId, relay: value.relay, identity: value.identity }
}

export function writeLastClient(storage: Pick<Storage, "setItem">, source: ClientSource): void {
  try {
    storage.setItem(LAST_CLIENT_KEY, JSON.stringify({ v: LAST_CLIENT_VERSION, runtimeId: source.runtimeId, relay: source.relay, identity: source.identity }))
  } catch {
    // A private window or blocked storage: the next load chooses without it.
  }
}

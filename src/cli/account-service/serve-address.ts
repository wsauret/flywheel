import type { GoneProof, HolderState, ProcessHolder } from "../../infra/process/process-holder.js"
import type { ServeStartRefusal } from "../../protocol/serve-handshake.js"
import { refusesAccess, type RendezvousProbe } from "./runtime-attach.js"
import type { RuntimeIdentity } from "./runtime-identity-record.js"

/** The service that published a lane's identity record and is proven gone. */
export interface PreviousService {
  readonly pid: number
  readonly version: string
  readonly buildId?: string
  readonly proof: GoneProof
}

/** What a start does at its lane's address, from its probe, the identity
 *  record, and whether the record's holder runs. */
type StartAddressVerdict =
  | { readonly kind: "park" }
  | { readonly kind: "refuse"; readonly reason: string; readonly refusal?: ServeStartRefusal; readonly clearsItself: boolean }
  | { readonly kind: "serve"; readonly previous?: PreviousService }

/** The one decision a start makes at its lane's address. An owner that
 *  answers parks the start. A path is taken over only when the probe proves
 *  that nobody serves there: a missing path, or a refused connection. A
 *  refused connection proves nothing while an identified holder of the record
 *  runs, because a service whose connection queue is full refuses too, and it
 *  proves nothing while the kernel does not answer for that holder. A record
 *  without identity keeps the rule that a refused connection means absence.
 *  A start that serves names the previous service when the record's holder is
 *  proven gone: that service ended without its exit path, which removes the
 *  record. */
export function startAddressVerdict(input: {
  readonly probe: RendezvousProbe
  readonly identity: RuntimeIdentity | undefined
  readonly state: (holder: ProcessHolder) => HolderState
  readonly socketPath: string
}): StartAddressVerdict {
  const { probe, identity } = input
  const owner = identity === undefined ? "the process at the account service address" : `the account service (pid ${identity.pid})`
  if (probe.kind === "listening") return { kind: "park" }
  if (probe.kind === "silent") return { kind: "refuse", clearsItself: false, reason: `${owner} accepted a connection and did not answer it` }
  if (probe.kind === "unknown") {
    const reason = `the account service address answered ${probe.code} to a connection, which proves neither a running service nor its absence`
    if (!refusesAccess(probe.code)) return { kind: "refuse", clearsItself: true, reason }
    return { kind: "refuse", clearsItself: false, reason, refusal: { kind: "address-access", path: input.socketPath, code: probe.code } }
  }
  if (identity === undefined) return { kind: "serve" }
  const held = input.state(identity.holder)
  if (probe.code === "ECONNREFUSED" && identity.holder.kind === "identified") {
    if (held.kind === "alive") return { kind: "refuse", clearsItself: false, reason: `${owner} runs but refused a connection: its connection queue is full` }
    if (held.kind === "unknown") return { kind: "refuse", clearsItself: true, reason: `${owner} refused a connection, and whether it runs is not known: ${held.reason}` }
  }
  if (held.kind !== "gone") return { kind: "serve" }
  return { kind: "serve", previous: { pid: identity.pid, version: identity.version, buildId: identity.buildId, proof: held.proof } }
}

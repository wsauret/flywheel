import {
  deviceAttachSigningBytes,
  fromBase64Url,
  keyDigest,
  ownedBytes,
  RELAY_PROTOCOL_VERSION,
  runtimeAttachSigningBytes,
  type DeviceFrame,
  type Placement,
  type PresencePlacement,
  type RelayRejectReason,
  type RuntimeControlFrame,
} from "../../../src/protocol/modules/remote/relay-protocol.js"

/** Admission decisions, as pure functions over the frames both ends send.
 *
 *  The relay trusts nothing it is told. A runtime is the key whose digest is
 *  the id it claims, proven by a signature over the nonce this socket was
 *  issued. A device is a key on the allowlist the runtime sent, proven the
 *  same way. A pairing channel is admitted once per window the runtime
 *  announced. Everything else is a typed refusal. */

export type RuntimeAttach = Extract<RuntimeControlFrame, { type: "attach" }>
type DeviceSigned = Extract<DeviceFrame, { type: "attach" | "presence" }>

async function verifyEd25519(publicKey: string, signature: string, bytes: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", ownedBytes(fromBase64Url(publicKey)), { name: "Ed25519" }, false, ["verify"])
    return await crypto.subtle.verify("Ed25519", key, ownedBytes(fromBase64Url(signature)), ownedBytes(bytes))
  } catch {
    return false
  }
}

/** Whether a runtime attach is what it claims: the contract version this
 *  relay speaks, an id that is the digest of the key, and a signature over the nonce. */
export async function admitRuntime(frame: RuntimeAttach, nonce: string, expectedRuntimeId: string): Promise<RelayRejectReason | "admitted"> {
  if (frame.relayProtocolVersion !== RELAY_PROTOCOL_VERSION) return "protocol_version"
  if (frame.runtimeId !== expectedRuntimeId) return "unknown_runtime"
  if ((await keyDigest(fromBase64Url(frame.publicKey))) !== frame.runtimeId) return "bad_signature"
  const signed = await verifyEd25519(frame.publicKey, frame.signature, runtimeAttachSigningBytes({ nonce, runtimeId: frame.runtimeId, placementId: frame.placement.id }))
  return signed ? "admitted" : "bad_signature"
}

export interface DeviceAdmissionContext {
  readonly expectedRuntimeId: string
  readonly nonce: string
  readonly allowlist: ReadonlySet<string>
  readonly placementsOnline: ReadonlySet<string>
}

/** Whether a signed device frame may proceed. `attach` also needs the named
 *  placement to be online; presence only needs the identity. */
export async function admitDevice(frame: DeviceSigned, context: DeviceAdmissionContext): Promise<RelayRejectReason | "admitted"> {
  if (frame.runtimeId !== context.expectedRuntimeId) return "unknown_runtime"
  if ((await keyDigest(fromBase64Url(frame.publicKey))) !== frame.deviceId) return "bad_signature"
  const signed = await verifyEd25519(frame.publicKey, frame.signature, deviceAttachSigningBytes({ nonce: context.nonce, runtimeId: frame.runtimeId, deviceId: frame.deviceId }))
  if (!signed) return "bad_signature"
  if (!context.allowlist.has(frame.deviceId)) return "device_not_paired"
  if (frame.type === "attach" && !context.placementsOnline.has(frame.placementId)) return "runtime_offline"
  return "admitted"
}

export interface PairingWindowRecord {
  readonly placementId: string
  /** The control socket that announced the window. Two processes may serve
   *  one placement at once (a pairing command beside a running runtime), and
   *  only the announcer holds the secret. */
  readonly socketId: string
  readonly expiresAt: number
}

/** Whether a pairing request names a live window. */
export function admitPairing(frame: Extract<DeviceFrame, { type: "pair" }>, context: { readonly expectedRuntimeId: string; readonly window: PairingWindowRecord | undefined; readonly now: number; readonly placementsOnline: ReadonlySet<string> }): RelayRejectReason | "admitted" {
  if (frame.runtimeId !== context.expectedRuntimeId) return "unknown_runtime"
  if (!context.window || context.window.expiresAt <= context.now) return "pairing_window_closed"
  if (!context.placementsOnline.has(context.window.placementId)) return "runtime_offline"
  return "admitted"
}

/** One live control socket's word about a placement, in the order the sockets
 *  arrived. */
export interface PlacementAnnouncement {
  readonly socketId: string
  readonly placement: Placement
}

/** The announcement a placement is served by. A runtime's `live` word beats
 *  the remote host's `dormant` one whatever their order, because a device
 *  attaching must reach the runtime that exists rather than ask the host to
 *  start another; among equals the newest socket wins, because two processes
 *  can serve one placement for a moment (a pairing command beside the running
 *  runtime) and the newest is the one a device should reach. */
export function servingAnnouncement<A extends PlacementAnnouncement>(announcements: readonly A[], placementId: string): A | undefined {
  const same = announcements.filter(({ placement }) => placement.id === placementId)
  return same.findLast(({ placement }) => placement.state === "live") ?? same.at(-1)
}

/** The placements presence reports: one per id, each as its serving
 *  announcement states it. */
export function servedPlacements(announcements: readonly PlacementAnnouncement[]): Placement[] {
  const ids = [...new Set(announcements.map(({ placement }) => placement.id))]
  return ids.flatMap((id) => {
    const serving = servingAnnouncement(announcements, id)
    return serving ? [serving.placement] : []
  })
}

/** A placement as presence reports it to a device: its protocol 3 shape,
 *  field by field, so nothing a runtime adds to its announcement reaches a
 *  phone that decodes presence strictly. */
export function presencePlacement(placement: Placement): PresencePlacement {
  return { id: placement.id, projectLabel: placement.projectLabel, version: placement.version, protocolVersion: placement.protocolVersion, state: placement.state }
}

/** When a socket that does not ping again falls silent: one deadline after
 *  its last ping. A socket that has not pinged yet is judged from when it
 *  arrived, so a fresh socket is live for one deadline and by its pings from
 *  then on. */
export function silentAt(socket: { readonly lastHeartbeatAt: number | undefined; readonly acceptedAt: number; readonly deadlineMs: number }): number {
  return (socket.lastHeartbeatAt ?? socket.acceptedAt) + socket.deadlineMs
}

/** A sliding-window counter: at most `limit` events per `windowMs`, keyed by
 *  whatever the caller chooses (a source address, a runtime id). Nothing is
 *  stored; abuse is a connection-slot and bandwidth question, not a record. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>()
  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** Records one event and says whether it was within the limit. */
  admit(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs)
    recent.push(now)
    this.hits.set(key, recent)
    return recent.length <= this.limit
  }
}

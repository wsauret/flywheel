import { Schema } from "effect"

import { CLIENT_IDENTITY_PATTERN } from "../../client-identity.js"

/** The relay contract: what the runtime, a paired device, and the relay say
 *  to each other before and around the runtime protocol.
 *
 *  The relay is a byte pump with presence. It admits a runtime by a signature
 *  over a nonce it minted, admits a device the same way against the allowlist
 *  the runtime sent, joins the two with one `open` on the runtime's control
 *  channel, and from then on copies binary frames it cannot read. Every frame
 *  here is small JSON text on a WebSocket; every frame after admission is a
 *  sealed binary frame whose format `sealed-socket.ts` owns and the
 *  relay never inspects.
 *
 *  This module is Bun-free and DOM-free: the Cloudflare Worker, the phone host,
 *  the runtime, and the extension all decode with these schemas. Bytes on the
 *  wire are base64url strings; identities are raw Ed25519 public keys and ids
 *  are the SHA-256 of a public key, so an id certifies its key and the relay
 *  needs no registration to trust one. */

/** The one relay protocol version this build speaks, and the one version
 *  the relay admits: a runtime on any other version hears `protocol_version`
 *  and tells the person to update. Version 5 adds `channel.ended`, which a
 *  runtime sends on its control channel. A relay of an earlier version
 *  refuses that frame as malformed, so the relay deploys before any build
 *  that speaks version 5 reaches main or a release, and every runtime on an
 *  earlier version stops reaching the relay until it updates. */
export const RELAY_PROTOCOL_VERSION = 5

/** The hosted relay every QR code names unless the user deploys their own. A
 *  hostname baked into every pairing code can never change once shipped. */
export const DEFAULT_RELAY_URL = "wss://relay.flywl.sh"
/** The hosted phone app. It learns the relay from the code, so one app serves
 *  the hosted relay and every self-hosted one. */
export const DEFAULT_REMOTE_APP_ORIGIN = "https://remote.flywl.sh"

/** Silence is evidence on every relay socket, the way it is on the event lane
 *  (ARCH-PROTOCOL-023). Every socket a client opens, control, device, and data channel
 *  alike, sends `ping` as it opens and every interval after, and the relay
 *  answers `pong` without waking the runtime's object. A client closes a
 *  socket and dials again once its pings have gone unanswered for
 *  `RELAY_MISSED_HEARTBEATS` intervals, counted in ticks of its own timer, so
 *  a timer that fires late, as a stalled event loop's, a hidden browser
 *  tab's, or a waking laptop's does, never ends a socket the relay still
 *  answers. A ping waits behind every byte queued ahead of it, so a tick at
 *  which the socket is still passing its backlog to the network counts
 *  nothing, and a data channel that has carried no data yet, which nothing
 *  queued can delay, is judged in one interval.
 *
 *  The relay judges each socket by the heartbeat the socket states in the URL
 *  it dials (`?heartbeatMs=<interval>`): it closes one that has sent neither a
 *  ping nor a frame for `RELAY_MISSED_HEARTBEATS` of its intervals, and closes
 *  the channel peer of one it closes. A runtime's control socket and data
 *  channels state their heartbeat, so a machine whose link died without a
 *  close leaves presence, and reaches its device, within that deadline. A
 *  socket that states none is judged by `RELAY_SILENCE_DEADLINE_MS`, the
 *  deadline the presence list keeps (PI-REMOTE-004) and the one runtimes
 *  released before sockets stated a heartbeat still ping within; a data
 *  channel that states none lasts while its device does. The two strings are
 *  exact because the relay matches them byte for byte. */
export const RELAY_HEARTBEAT_INTERVAL_MS = 5_000
export const RELAY_MISSED_HEARTBEATS = 3
export const RELAY_SILENCE_DEADLINE_MS = 75_000
/** How long a dormant project may take to report live after its host starts it. */
export const RELAY_PROJECT_START_TIMEOUT_MS = 90_000
/** The range of intervals the relay honors. A shorter one would wake the
 *  runtime's object more often than a heartbeat is worth; a longer one gains
 *  nothing over stating none. */
export const RELAY_MIN_STATED_HEARTBEAT_MS = 1_000
const RELAY_MAX_STATED_HEARTBEAT_MS = RELAY_SILENCE_DEADLINE_MS / RELAY_MISSED_HEARTBEATS
export const RELAY_PING = JSON.stringify({ type: "ping" })
export const RELAY_PONG = JSON.stringify({ type: "pong" })
const STATED_HEARTBEAT_PARAMETER = "heartbeatMs"

/** The URL to dial so the relay holds the socket to the heartbeat it keeps. */
export function withStatedHeartbeat(url: string, intervalMs: number): string {
  return `${url}?${STATED_HEARTBEAT_PARAMETER}=${Math.round(intervalMs)}`
}

/** How long the relay lets a socket dialed at `url` stay silent before it
 *  closes it, or undefined when the socket stated no heartbeat it honors. */
export function statedSilenceDeadlineMs(url: URL): number | undefined {
  const stated = Number(url.searchParams.get(STATED_HEARTBEAT_PARAMETER) ?? Number.NaN)
  if (!Number.isInteger(stated) || stated < RELAY_MIN_STATED_HEARTBEAT_MS || stated > RELAY_MAX_STATED_HEARTBEAT_MS) return undefined
  return stated * RELAY_MISSED_HEARTBEATS
}

/** Base64url without padding, the only byte encoding the contract uses. Hand
 *  written because `Buffer` is Node's and `Uint8Array.prototype.toBase64` is not
 *  yet everywhere the client runs. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/[=]+$/, "")
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const BASE64URL = /^[A-Za-z0-9_-]+$/
const Base64Url = Schema.String.check(Schema.isPattern(BASE64URL))
/** A raw Ed25519 or X25519 public key: 32 bytes, 43 base64url characters. */
const PublicKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/))
/** SHA-256 of a public key: 32 bytes, 43 base64url characters. */
const KeyDigest = PublicKey
const Signature = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{86}$/))

export type RelayRejectReason =
  | "bad_signature"
  | "unknown_runtime"
  | "runtime_offline"
  | "device_not_paired"
  | "pairing_window_closed"
  | "protocol_version"
  | "rate_limited"
  | "malformed"
  | "channel_limit"
  /** The placement is asleep and its machine's account service is opening a
   *  runtime for it; presence reports the placement live once it attaches. */
  | "runtime_starting"
  /** The account service tried to open the placement and failed. */
  | "runtime_unavailable"
  /** The runtime's channels have carried the relay's daily byte budget for
   *  this runtime id; the relay admits its devices again after midnight UTC. */
  | "daily_budget"
  /** The relay's operator has stopped admitting runtimes (`RELAY_ADMISSION`). */
  | "admission_closed"

/** A client of an earlier build does not know the two newest reasons, fails
 *  to decode the frame, and treats it as the socket ending, which it already
 *  retries; so the reasons need no new protocol version. */
const RelayRejectReasonSchema: Schema.Codec<RelayRejectReason> = Schema.Literals(["bad_signature", "unknown_runtime", "runtime_offline", "device_not_paired", "pairing_window_closed", "protocol_version", "rate_limited", "malformed", "channel_limit", "runtime_starting", "runtime_unavailable", "daily_budget", "admission_closed"])

/** Whether a placement is served by a running runtime (`live`) or only
 *  announced by the machine's account service, which opens it when
 *  a device attaches (`dormant`). */
type PlacementState = "live" | "dormant"
const PlacementStateSchema: Schema.Codec<PlacementState> = Schema.Literals(["live", "dormant"])

const ClientIdentity = Schema.String.check(Schema.isPattern(CLIENT_IDENTITY_PATTERN))

/** One placement of a paired machine as presence reports it to a device: a
 *  project the machine serves or can start. A machine has one identity and
 *  one control channel per placement, so the relay lists placements and a
 *  device chooses one. This shape is frozen at relay protocol 3, because the
 *  phone app deployed then decodes presence strictly and must keep reading it
 *  whatever runtimes and relays come after. */
const PresencePlacementSchema = Schema.Struct({
  id: KeyDigest,
  projectLabel: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  protocolVersion: Schema.Number,
  state: PlacementStateSchema,
})
export type PresencePlacement = typeof PresencePlacementSchema.Type

/** A placement as its runtime announces it to the relay: the presence shape
 *  plus `clientIdentity`, the web client the process behind the placement
 *  serves. The relay keeps the identity to serve that client and answers it
 *  at `/client/<runtimeId>/current`; it never sends it in presence. It is
 *  absent while the process has no client to serve, such as a source run
 *  whose client did not build. */
const PlacementSchema = Schema.Struct({
  ...PresencePlacementSchema.fields,
  clientIdentity: Schema.optionalKey(ClientIdentity),
})
export type Placement = typeof PlacementSchema.Type

/** The relay's first word on any socket. */
const ChallengeFrameSchema = Schema.Struct({ type: Schema.Literal("challenge"), nonce: Base64Url })
/** The heartbeat pair. The relay answers a ping below its frame handlers, so
 *  these reach a handler only on a relay that does not. */
const PingFrameSchema = Schema.Struct({ type: Schema.Literal("ping") })
const PongFrameSchema = Schema.Struct({ type: Schema.Literal("pong") })

// Control channel, runtime to relay.
const RuntimeAttachFrameSchema = Schema.Struct({
  type: Schema.Literal("attach"),
  relayProtocolVersion: Schema.Number,
  runtimeId: KeyDigest,
  publicKey: PublicKey,
  placement: PlacementSchema,
  devices: Schema.Array(KeyDigest),
  signature: Signature,
})
const DevicesFrameSchema = Schema.Struct({ type: Schema.Literal("devices"), devices: Schema.Array(KeyDigest) })
const PairingOpenFrameSchema = Schema.Struct({ type: Schema.Literal("pairing.open"), windowId: Base64Url, expiresAt: Schema.Number })
const PairingCloseFrameSchema = Schema.Struct({ type: Schema.Literal("pairing.close"), windowId: Base64Url })
/** A dormant placement's answer to `open`: the host will not dial the channel.
 *  `starting` means a runtime is on its way and the device should wait for the
 *  placement to report live. The relay keeps the wake socket open for a later
 *  `start_failed`, which means it is not coming. */
const DeclineFrameSchema = Schema.Struct({ type: Schema.Literal("decline"), channelId: Base64Url, reason: Schema.Literals(["starting", "start_failed"]) })
/** A client asset request's id: 16 random bytes, which also lead every
 *  binary chunk frame that answers it. */
const AssetRequestId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/))
/** One file of the phone's client bundle, by bare name: the machine reads it
 *  from its own client build and nowhere else. */
const CLIENT_ASSET_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const ClientFile = Schema.String.check(Schema.isPattern(CLIENT_ASSET_FILE_PATTERN))
/** The machine's answer to `asset.request`: the file exists and its bytes
 *  follow as binary chunk frames, then `asset.end`. */
const AssetHeadFrameSchema = Schema.Struct({ type: Schema.Literal("asset.head"), requestId: AssetRequestId, contentType: Schema.NonEmptyString })
/** The machine does not serve that identity or has no such file. */
const AssetMissingFrameSchema = Schema.Struct({ type: Schema.Literal("asset.missing"), requestId: AssetRequestId })
const AssetEndFrameSchema = Schema.Struct({ type: Schema.Literal("asset.end"), requestId: AssetRequestId })
/** The runtime's side of a data channel this machine dialed ended with no
 *  close handshake: the connection dropped, or its heartbeat gave up. The
 *  relay may never hear that end, and would pump the device's frames into
 *  the dead socket until its stated heartbeat went silent. On this word the
 *  relay closes the device's side at once, so the device dials again. A
 *  channel the relay no longer holds makes it a no-op. */
const ChannelEndedFrameSchema = Schema.Struct({ type: Schema.Literal("channel.ended"), channelId: Base64Url })
const RuntimeControlFrameSchema = Schema.Union([RuntimeAttachFrameSchema, DevicesFrameSchema, PairingOpenFrameSchema, PairingCloseFrameSchema, DeclineFrameSchema, AssetHeadFrameSchema, AssetMissingFrameSchema, AssetEndFrameSchema, ChannelEndedFrameSchema, PingFrameSchema])
export type RuntimeControlFrame = typeof RuntimeControlFrameSchema.Type

// Control channel, relay to runtime.
const OpenFrameSchema = Schema.Struct({
  type: Schema.Literal("open"),
  channelId: Base64Url,
  /** Proves to the relay that the socket dialing this channel is the runtime it
   *  told to dial. Random, single use, and never a secret worth keeping. */
  ticket: Base64Url,
  kind: Schema.Literals(["device", "pairing"]),
  deviceId: Schema.optionalKey(KeyDigest),
  windowId: Schema.optionalKey(Base64Url),
})
export type OpenFrame = typeof OpenFrameSchema.Type
/** Asks the machine for one file of the client it announced, so the relay
 *  can serve and cache it for a phone (`GET /client/...`). */
const AssetRequestFrameSchema = Schema.Struct({ type: Schema.Literal("asset.request"), requestId: AssetRequestId, identity: ClientIdentity, file: ClientFile })
export type AssetRequestFrame = typeof AssetRequestFrameSchema.Type
const RelayControlFrameSchema = Schema.Union([
  ChallengeFrameSchema,
  Schema.Struct({ type: Schema.Literal("attached") }),
  Schema.Struct({ type: Schema.Literal("rejected"), reason: RelayRejectReasonSchema }),
  OpenFrameSchema,
  AssetRequestFrameSchema,
  PongFrameSchema,
])
export type RelayControlFrame = typeof RelayControlFrameSchema.Type

// Device channel, device to relay.
const DeviceIdentity = {
  runtimeId: KeyDigest,
  deviceId: KeyDigest,
  publicKey: PublicKey,
  signature: Signature,
}
/** Subscribes to which placements of the runtime are online. */
const DevicePresenceFrameSchema = Schema.Struct({ type: Schema.Literal("presence"), ...DeviceIdentity })
/** Attaches to one placement; on `attached` the socket becomes a data channel. */
const DeviceAttachFrameSchema = Schema.Struct({ type: Schema.Literal("attach"), placementId: KeyDigest, ...DeviceIdentity })
/** Opens the one pairing channel a window admits. Nothing is signed: the
 *  pairing secret authenticates the two ends inside the sealed channel. */
const DevicePairFrameSchema = Schema.Struct({ type: Schema.Literal("pair"), runtimeId: KeyDigest, windowId: Base64Url })
const DeviceFrameSchema = Schema.Union([DevicePresenceFrameSchema, DeviceAttachFrameSchema, DevicePairFrameSchema, PingFrameSchema])
export type DeviceFrame = typeof DeviceFrameSchema.Type

// Device channel, relay to device.
const RelayDeviceFrameSchema = Schema.Union([
  ChallengeFrameSchema,
  Schema.Struct({ type: Schema.Literal("presence"), placements: Schema.Array(PresencePlacementSchema) }),
  Schema.Struct({ type: Schema.Literal("attached") }),
  Schema.Struct({ type: Schema.Literal("rejected"), reason: RelayRejectReasonSchema }),
  PongFrameSchema,
])
export type RelayDeviceFrame = typeof RelayDeviceFrameSchema.Type

// Data channel, runtime to relay: the one text frame before the pump starts.
const ChannelAcceptFrameSchema = Schema.Struct({ type: Schema.Literal("accept"), runtimeId: KeyDigest, channelId: Base64Url, ticket: Base64Url })
export type ChannelAcceptFrame = typeof ChannelAcceptFrameSchema.Type

/** What one end says first inside a data channel: its identity, a fresh
 *  ephemeral key, and the identity's signature over the ephemeral key. The
 *  sealed socket derives the channel key from the two ephemerals. */
const SealedHelloSchema = Schema.Struct({
  v: Schema.Literal(1),
  role: Schema.Literals(["runtime", "device"]),
  identityPublicKey: PublicKey,
  ephemeralPublicKey: PublicKey,
  signature: Signature,
})

/** The pairing exchange, carried as sealed plaintext inside the pairing
 *  channel. Each end learned the other's identity key from the hello; the
 *  exchange names the two ends for their device lists. */
const PairingRequestSchema = Schema.Struct({ type: Schema.Literal("pair.request"), label: Schema.NonEmptyString })
const PairingResultSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("pair.accepted"), runtimeLabel: Schema.NonEmptyString }),
  Schema.Struct({ type: Schema.Literal("pair.rejected"), reason: Schema.NonEmptyString }),
])
export type PairingResult = typeof PairingResultSchema.Type

/** What a QR code carries: everything a phone needs to open the one pairing
 *  channel a window admits. `secret` is the whole credential for the window's
 *  lifetime. The runtime id is not carried; it is the digest of `publicKey`. */
export interface PairingCode {
  readonly v: 1
  readonly relay: string
  readonly publicKey: string
  readonly windowId: string
  readonly secret: string
  readonly label: string
  readonly expiresAt: number
}

const decodeOptions = { onExcessProperty: "error" } as const
export const decodeRuntimeControlFrame = Schema.decodeUnknownSync(RuntimeControlFrameSchema, decodeOptions)
export const decodeRelayControlFrame = Schema.decodeUnknownSync(RelayControlFrameSchema, decodeOptions)
export const decodeDeviceFrame = Schema.decodeUnknownSync(DeviceFrameSchema, decodeOptions)
export const decodeRelayDeviceFrame = Schema.decodeUnknownSync(RelayDeviceFrameSchema, decodeOptions)
export const decodeChannelAcceptFrame = Schema.decodeUnknownSync(ChannelAcceptFrameSchema, decodeOptions)
/** The relay's answer at `/client/<runtimeId>/current`: the client identity
 *  that runtime serves, which the phone's hosted page loads. */
export const decodeCurrentClient = Schema.decodeUnknownSync(Schema.Struct({ identity: ClientIdentity }), decodeOptions)
export const decodeSealedHello = Schema.decodeUnknownSync(SealedHelloSchema, decodeOptions)
export const decodePairingRequest = Schema.decodeUnknownSync(PairingRequestSchema, decodeOptions)
export const decodePairingResult = Schema.decodeUnknownSync(PairingResultSchema, decodeOptions)

/** Reads one JSON text frame with a decoder. A frame that is not JSON, not an
 *  object, or not the schema is one failure, because every one of them means
 *  the other end is not speaking this contract. */
export function decodeJsonFrame<T>(decode: (value: unknown) => T, text: string): T {
  return decode(JSON.parse(text))
}

/** The most bytes one client asset chunk carries. One chunk is one binary
 *  frame from the machine and one storage row at the relay, which keeps every
 *  row under the edge's per-row limit (POC 10). */
export const ASSET_CHUNK_BYTES = 1024 * 1024
const ASSET_REQUEST_ID_BYTES = 16

export function newAssetRequestId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(ASSET_REQUEST_ID_BYTES)))
}

/** The one binary frame a runtime may send on its control channel: the raw
 *  request id, then at most one chunk of the file it answers. */
export function encodeAssetChunk(requestId: string, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.byteLength > ASSET_CHUNK_BYTES) throw new Error(`an asset chunk carries at most ${ASSET_CHUNK_BYTES} bytes`)
  const id = fromBase64Url(requestId)
  if (id.byteLength !== ASSET_REQUEST_ID_BYTES) throw new Error("an asset request id is 16 bytes")
  const frame = new Uint8Array(ASSET_REQUEST_ID_BYTES + bytes.byteLength)
  frame.set(id)
  frame.set(bytes, ASSET_REQUEST_ID_BYTES)
  return frame
}

export function decodeAssetChunk(frame: ArrayBuffer | Uint8Array) {
  const view = frame instanceof Uint8Array ? frame : new Uint8Array(frame)
  if (view.byteLength <= ASSET_REQUEST_ID_BYTES || view.byteLength > ASSET_REQUEST_ID_BYTES + ASSET_CHUNK_BYTES) throw new Error("not an asset chunk frame")
  return { requestId: toBase64Url(view.subarray(0, ASSET_REQUEST_ID_BYTES)), bytes: view.subarray(ASSET_REQUEST_ID_BYTES) }
}

/** The protocol version a runtime's attach frame claims, read before the frame's
 *  shape is checked. The attach frame is the one frame whose shape changes
 *  between versions, so a relay that decodes it strictly first cannot tell a
 *  runtime on an older build from one sending garbage, and would refuse both
 *  as malformed. This field is the part of the frame every version shares, so
 *  the relay reads it first and refuses a version mismatch by its own name.
 *  Anything that is not an attach frame carrying a numeric version reads as
 *  no claim, and takes the strict decode. */
export function claimedRelayProtocolVersion(frame: unknown): number | undefined {
  if (typeof frame !== "object" || frame === null) return undefined
  if (!("type" in frame) || frame.type !== "attach" || !("relayProtocolVersion" in frame)) return undefined
  return typeof frame.relayProtocolVersion === "number" ? frame.relayProtocolVersion : undefined
}

const textEncoder = new TextEncoder()

/** The bytes a runtime signs to attach: the relay's nonce bound to this
 *  runtime's id and placement, under a label no other signing use shares. */
export function runtimeAttachSigningBytes(input: { readonly nonce: string; readonly runtimeId: string; readonly placementId: string }): Uint8Array {
  return textEncoder.encode(`flywheel-relay-runtime-attach\n${input.nonce}\n${input.runtimeId}\n${input.placementId}`)
}

/** The bytes a device signs to attach or watch presence. */
export function deviceAttachSigningBytes(input: { readonly nonce: string; readonly runtimeId: string; readonly deviceId: string }): Uint8Array {
  return textEncoder.encode(`flywheel-relay-device-attach\n${input.nonce}\n${input.runtimeId}\n${input.deviceId}`)
}

/** The bytes an identity signs over its ephemeral key in the sealed hello. The
 *  role is in the label so a runtime hello can never be replayed as a device
 *  hello. */
export function sealedHelloSigningBytes(input: { readonly role: "runtime" | "device"; readonly ephemeralPublicKey: string }): Uint8Array {
  return textEncoder.encode(`flywheel-sealed-hello-${input.role}\n${input.ephemeralPublicKey}`)
}

/** WebCrypto wants a view over a plain ArrayBuffer, and a view over a shared or
 *  resizable buffer is refused at the type level. One copy settles it. */
export function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

/** The self-certifying id of a public key. */
export async function keyDigest(publicKey: Uint8Array): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", ownedBytes(publicKey))))
}

/** Bun types `generateKey` as returning either a pair or a symmetric key; an
 *  asymmetric algorithm always yields the pair, and this says so without a cast. */
export function asKeyPair(generated: CryptoKey | CryptoKeyPair): CryptoKeyPair {
  if ("privateKey" in generated) return generated
  throw new Error("expected an asymmetric key pair")
}

/** The pairing code as a URL on the phone host, so the native camera opens
 *  the app directly and the fragment keeps the payload out of request logs.
 *
 *  The payload is a dotted list rather than JSON because every byte is QR
 *  modules a terminal has to show: this shape fits a version 7 code, about 45
 *  modules a side, where JSON needed a code too tall for an 80x40 terminal.
 *  The relay is omitted when it is the hosted default. */
export function pairingCodeUrl(appOrigin: string, code: PairingCode): string {
  const fields = [String(code.v), code.publicKey, code.windowId, code.secret, code.expiresAt.toString(36), toBase64Url(textEncoder.encode(code.label))]
  if (code.relay !== DEFAULT_RELAY_URL) fields.push(toBase64Url(textEncoder.encode(code.relay)))
  return `${appOrigin}/#p=${fields.join(".")}`
}

const PAIRING_FIELD = /^[A-Za-z0-9_-]+$/

/** Reads a pairing code back out of the URL, or the bare fragment value. */
export function parsePairingCodeUrl(text: string): PairingCode {
  const hash = text.includes("#") ? text.slice(text.indexOf("#") + 1) : text
  const encoded = new URLSearchParams(hash).get("p") ?? hash
  const fields = encoded.split(".")
  const [version, publicKey, windowId, secret, expires, label, relay] = fields
  if (fields.length < 6 || fields.length > 7 || version !== "1" || !fields.every((field) => PAIRING_FIELD.test(field))) {
    throw new Error("not a Flywheel pairing code")
  }
  if (publicKey === undefined || publicKey.length !== 43 || windowId === undefined || secret === undefined || expires === undefined || label === undefined) {
    throw new Error("not a Flywheel pairing code")
  }
  const expiresAt = Number.parseInt(expires, 36)
  if (!Number.isFinite(expiresAt)) throw new Error("not a Flywheel pairing code")
  return {
    v: 1,
    relay: relay === undefined ? DEFAULT_RELAY_URL : new TextDecoder().decode(fromBase64Url(relay)),
    publicKey,
    windowId,
    secret,
    label: new TextDecoder().decode(fromBase64Url(label)),
    expiresAt,
  }
}

import { describe, expect, test } from "bun:test"

import {
  ASSET_CHUNK_BYTES,
  claimedRelayProtocolVersion,
  decodeAssetChunk,
  decodeCurrentClient,
  DEFAULT_RELAY_URL,
  decodeDeviceFrame,
  decodeJsonFrame,
  decodeRelayControlFrame,
  decodeRelayDeviceFrame,
  decodeRuntimeControlFrame,
  encodeAssetChunk,
  fromBase64Url,
  keyDigest,
  newAssetRequestId,
  pairingCodeUrl,
  parsePairingCodeUrl,
  RELAY_PROTOCOL_VERSION,
  toBase64Url,
  type PairingCode,
  type RelayControlFrame,
  type RuntimeControlFrame,
} from "../../../../../src/protocol/modules/remote/relay-protocol.js"

/** The relay contract is decoded at three trust boundaries: the Worker reads
 *  the runtime and the device, and both read the Worker. Every one of them
 *  decodes strictly, so a frame with a field the contract does not name is a
 *  refusal rather than something to work around. */

const KEY = toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
const SIGNATURE = toBase64Url(crypto.getRandomValues(new Uint8Array(64)))
const NONCE = toBase64Url(crypto.getRandomValues(new Uint8Array(32)))

describe("relay protocol frames", () => {
  test("base64url round-trips bytes without padding", () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255])
    const text = toBase64Url(bytes)
    expect(text).not.toContain("=")
    expect(text).not.toContain("+")
    expect(text).not.toContain("/")
    expect([...fromBase64Url(text)]).toEqual([...bytes])
  })

  test("decodes a runtime attach frame and refuses an extra field", () => {
    const frame: RuntimeControlFrame = {
      type: "attach",
      relayProtocolVersion: 1,
      runtimeId: KEY,
      publicKey: KEY,
      placement: { id: KEY, projectLabel: "flywheel", version: "0.0.8", protocolVersion: 2, state: "live" },
      devices: [KEY],
      signature: SIGNATURE,
    }
    expect(decodeJsonFrame(decodeRuntimeControlFrame, JSON.stringify(frame))).toEqual(frame)
    expect(() => decodeJsonFrame(decodeRuntimeControlFrame, JSON.stringify({ ...frame, extra: 1 }))).toThrow()
    expect(() => decodeJsonFrame(decodeRuntimeControlFrame, JSON.stringify({ ...frame, publicKey: "short" }))).toThrow()
    // A placement states whether a runtime serves it; a frame without that word is an older contract.
    const { state: _state, ...unstated } = frame.placement
    expect(() => decodeJsonFrame(decodeRuntimeControlFrame, JSON.stringify({ ...frame, placement: unstated }))).toThrow()
    expect(() => decodeJsonFrame(decodeRuntimeControlFrame, JSON.stringify(frame).replace('"state":"live"', '"state":"napping"'))).toThrow()
  })

  test("decodes a dormant placement's decline and the reasons a device hears for it", () => {
    const starting: RuntimeControlFrame = { type: "decline", channelId: "abc", reason: "starting" }
    const failed: RuntimeControlFrame = { type: "decline", channelId: "abc", reason: "start_failed" }
    expect(decodeJsonFrame(decodeRuntimeControlFrame, JSON.stringify(starting))).toEqual(starting)
    expect(decodeJsonFrame(decodeRuntimeControlFrame, JSON.stringify(failed))).toEqual(failed)
    expect(() => decodeJsonFrame(decodeRuntimeControlFrame, JSON.stringify(starting).replace("starting", "busy"))).toThrow()
    for (const reason of ["runtime_starting", "runtime_unavailable"] as const) {
      expect(decodeJsonFrame(decodeRelayDeviceFrame, JSON.stringify({ type: "rejected", reason }))).toEqual({ type: "rejected", reason })
    }
  })

  test("decodes the relay's open frame with an optional device id", () => {
    const open: RelayControlFrame = { type: "open", channelId: "abc", ticket: "def", kind: "device", deviceId: KEY }
    expect(decodeJsonFrame(decodeRelayControlFrame, JSON.stringify(open))).toEqual(open)
    expect(decodeJsonFrame(decodeRelayControlFrame, JSON.stringify({ type: "challenge", nonce: NONCE }))).toEqual({ type: "challenge", nonce: NONCE })
    expect(() => decodeJsonFrame(decodeRelayControlFrame, JSON.stringify({ type: "rejected", reason: "because" }))).toThrow()
  })

  test("decodes every device frame kind", () => {
    const identity = { runtimeId: KEY, deviceId: KEY, publicKey: KEY, signature: SIGNATURE }
    expect(decodeJsonFrame(decodeDeviceFrame, JSON.stringify({ type: "presence", ...identity }))).toEqual({ type: "presence", ...identity })
    expect(decodeJsonFrame(decodeDeviceFrame, JSON.stringify({ type: "attach", placementId: KEY, ...identity }))).toEqual({ type: "attach", placementId: KEY, ...identity })
    expect(decodeJsonFrame(decodeDeviceFrame, JSON.stringify({ type: "pair", runtimeId: KEY, windowId: "w1" }))).toEqual({ type: "pair", runtimeId: KEY, windowId: "w1" })
    expect(() => decodeJsonFrame(decodeDeviceFrame, "not json")).toThrow()
  })

  test("a key digest is stable and self-certifying", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32))
    expect(await keyDigest(key)).toBe(await keyDigest(new Uint8Array(key)))
    expect((await keyDigest(key)).length).toBe(43)
  })

  test("a pairing code survives the QR URL round trip", () => {
    const code: PairingCode = { v: 1, relay: DEFAULT_RELAY_URL, publicKey: KEY, windowId: "w1", secret: "s3cret", label: "desk", expiresAt: 1_700_000_000_000 }
    const url = pairingCodeUrl("https://remote.flywl.sh", code)
    expect(url.startsWith("https://remote.flywl.sh/#p=1.")).toBe(true)
    // Short enough for a terminal QR code: the hosted relay adds no field.
    expect(url.length).toBeLessThan(140)
    expect(parsePairingCodeUrl(url)).toEqual(code)
    expect(parsePairingCodeUrl(url.slice(url.indexOf("#") + 1))).toEqual(code)
    const selfHosted = { ...code, relay: "wss://relay.example.test", label: "my project" }
    expect(parsePairingCodeUrl(pairingCodeUrl("https://remote.flywl.sh", selfHosted))).toEqual(selfHosted)
    expect(() => parsePairingCodeUrl("https://remote.flywl.sh/#p=2.x")).toThrow(/pairing code/)
  })
})

describe("client assets on the control channel", () => {
  const IDENTITY = "a".repeat(64)
  const PLACEMENT = { id: KEY, projectLabel: "flywheel", version: "0.0.11", protocolVersion: 11, state: "live" } as const

  test("a placement may name the client identity it serves, and only a client identity", () => {
    const frame: RuntimeControlFrame = { type: "attach", relayProtocolVersion: RELAY_PROTOCOL_VERSION, runtimeId: KEY, publicKey: KEY, placement: { ...PLACEMENT, clientIdentity: IDENTITY }, devices: [], signature: SIGNATURE }
    expect(decodeJsonFrame(decodeRuntimeControlFrame, JSON.stringify(frame))).toEqual(frame)
    expect(decodeJsonFrame(decodeRuntimeControlFrame, JSON.stringify({ ...frame, placement: PLACEMENT }))).toEqual({ ...frame, placement: PLACEMENT })
    expect(() => decodeJsonFrame(decodeRuntimeControlFrame, JSON.stringify({ ...frame, placement: { ...PLACEMENT, clientIdentity: "not-a-hash" } }))).toThrow()
    // The device lane keeps the version 3 shape the phone app deployed before
    // client assets reads strictly: the identity never travels in presence.
    expect(decodeJsonFrame(decodeRelayDeviceFrame, JSON.stringify({ type: "presence", placements: [PLACEMENT] }))).toEqual({ type: "presence", placements: [PLACEMENT] })
    expect(() => decodeJsonFrame(decodeRelayDeviceFrame, JSON.stringify({ type: "presence", placements: [{ ...PLACEMENT, clientIdentity: IDENTITY }] }))).toThrow()
  })

  test("the relay's answer to which client a runtime serves is one client identity", () => {
    expect(decodeCurrentClient(JSON.parse(JSON.stringify({ identity: IDENTITY })))).toEqual({ identity: IDENTITY })
    expect(() => decodeCurrentClient({ identity: "not-a-hash" })).toThrow()
    expect(() => decodeCurrentClient({ identity: IDENTITY, extra: 1 })).toThrow()
  })

  test("the relay asks for one bare file of one identity", () => {
    const requestId = newAssetRequestId()
    const request: RelayControlFrame = { type: "asset.request", requestId, identity: IDENTITY, file: "webview.js" }
    expect(decodeJsonFrame(decodeRelayControlFrame, JSON.stringify(request))).toEqual(request)
    for (const file of ["../client.json", "phone/webview.js", ".hidden", ""]) {
      expect(() => decodeJsonFrame(decodeRelayControlFrame, JSON.stringify({ ...request, file }))).toThrow()
    }
    expect(() => decodeJsonFrame(decodeRelayControlFrame, JSON.stringify({ ...request, requestId: "short" }))).toThrow()
  })

  test("the machine answers with a head or a refusal, then an end", () => {
    const requestId = newAssetRequestId()
    const frames: RuntimeControlFrame[] = [
      { type: "asset.head", requestId, contentType: "text/javascript; charset=utf-8" },
      { type: "asset.missing", requestId },
      { type: "asset.end", requestId },
    ]
    for (const frame of frames) expect(decodeJsonFrame(decodeRuntimeControlFrame, JSON.stringify(frame))).toEqual(frame)
    expect(() => decodeJsonFrame(decodeRuntimeControlFrame, JSON.stringify({ type: "asset.head", requestId }))).toThrow()
  })

  test("a chunk frame carries its request id ahead of at most one chunk of bytes", () => {
    const requestId = newAssetRequestId()
    const bytes = crypto.getRandomValues(new Uint8Array(1000))
    const frame = encodeAssetChunk(requestId, bytes)
    expect(frame.byteLength).toBe(16 + bytes.byteLength)
    const decoded = decodeAssetChunk(frame.buffer)
    expect(decoded.requestId).toBe(requestId)
    expect([...decoded.bytes]).toEqual([...bytes])
    expect(ASSET_CHUNK_BYTES).toBe(1024 * 1024)
    expect(() => encodeAssetChunk(requestId, new Uint8Array(ASSET_CHUNK_BYTES + 1))).toThrow()
    expect(() => decodeAssetChunk(new Uint8Array(16).buffer)).toThrow()
  })
})

describe("the attach frame's version claim", () => {
  test("names the contract whose control channel reports the data channels it saw end as version 5", () => {
    expect(RELAY_PROTOCOL_VERSION).toBe(5)
  })

  test("is read from an attach frame whatever shape the rest of it takes", () => {
    expect(claimedRelayProtocolVersion({ type: "attach", relayProtocolVersion: 1, placement: "an older shape" })).toBe(1)
    expect(claimedRelayProtocolVersion({ type: "attach", relayProtocolVersion: 7 })).toBe(7)
  })

  test("is no claim for anything that is not an attach frame with a numeric version", () => {
    expect(claimedRelayProtocolVersion({ type: "devices", devices: [] })).toBeUndefined()
    expect(claimedRelayProtocolVersion({ type: "attach", relayProtocolVersion: "2" })).toBeUndefined()
    expect(claimedRelayProtocolVersion({ type: "attach" })).toBeUndefined()
    expect(claimedRelayProtocolVersion("attach")).toBeUndefined()
    expect(claimedRelayProtocolVersion(null)).toBeUndefined()
  })
})

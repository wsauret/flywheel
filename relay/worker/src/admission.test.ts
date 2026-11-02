import { describe, expect, test } from "bun:test"

import { asKeyPair, deviceAttachSigningBytes, keyDigest, ownedBytes, RELAY_SILENCE_DEADLINE_MS, RELAY_PROTOCOL_VERSION, runtimeAttachSigningBytes, toBase64Url } from "../../../src/protocol/modules/remote/relay-protocol.js"
import { admitDevice, admitPairing, admitRuntime, RateLimiter, servedPlacements, servingAnnouncement, silentAt, type RuntimeAttach } from "./admission.js"

/** The relay's admission rules, held to the frames a real runtime and device
 *  sign, so a Worker change that loosened a check would fail here before it
 *  reached a hostname users pair against. */

async function identity() {
  const pair = asKeyPair(await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]))
  const exported = await crypto.subtle.exportKey("raw", pair.publicKey)
  if (!(exported instanceof ArrayBuffer)) throw new Error("expected raw key bytes")
  const publicKey = new Uint8Array(exported)
  return {
    publicKey: toBase64Url(publicKey),
    id: await keyDigest(publicKey),
    sign: async (bytes: Uint8Array) => toBase64Url(new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, ownedBytes(bytes)))),
  }
}

const PLACEMENT = { id: "p".repeat(43), projectLabel: "flywheel", version: "0.0.8", protocolVersion: 2, state: "live" as const }
const NONCE = "nonce-1"

describe("runtime admission", () => {
  test("admits a runtime whose id is its key's digest and whose signature covers the nonce", async () => {
    const runtime = await identity()
    const frame: RuntimeAttach = { type: "attach", relayProtocolVersion: RELAY_PROTOCOL_VERSION, runtimeId: runtime.id, publicKey: runtime.publicKey, placement: PLACEMENT, devices: [], signature: await runtime.sign(runtimeAttachSigningBytes({ nonce: NONCE, runtimeId: runtime.id, placementId: PLACEMENT.id })) }
    expect(await admitRuntime(frame, NONCE, runtime.id)).toBe("admitted")
    expect(await admitRuntime(frame, "another-nonce", runtime.id)).toBe("bad_signature")
    expect(await admitRuntime({ ...frame, relayProtocolVersion: 99 }, NONCE, runtime.id)).toBe("protocol_version")
    expect(await admitRuntime(frame, NONCE, "x".repeat(43))).toBe("unknown_runtime")
  })

  test("refuses a correctly signed runtime on any earlier relay protocol by its version", async () => {
    const runtime = await identity()
    const frame: RuntimeAttach = { type: "attach", relayProtocolVersion: RELAY_PROTOCOL_VERSION, runtimeId: runtime.id, publicKey: runtime.publicKey, placement: PLACEMENT, devices: [], signature: await runtime.sign(runtimeAttachSigningBytes({ nonce: NONCE, runtimeId: runtime.id, placementId: PLACEMENT.id })) }
    for (const relayProtocolVersion of [2, 3, 4]) expect(await admitRuntime({ ...frame, relayProtocolVersion }, NONCE, runtime.id)).toBe("protocol_version")
  })

  test("refuses a key that does not hash to the claimed id", async () => {
    const runtime = await identity()
    const impostor = await identity()
    const frame: RuntimeAttach = { type: "attach", relayProtocolVersion: RELAY_PROTOCOL_VERSION, runtimeId: runtime.id, publicKey: impostor.publicKey, placement: PLACEMENT, devices: [], signature: await impostor.sign(runtimeAttachSigningBytes({ nonce: NONCE, runtimeId: runtime.id, placementId: PLACEMENT.id })) }
    expect(await admitRuntime(frame, NONCE, runtime.id)).toBe("bad_signature")
  })
})

describe("device admission", () => {
  test("admits a paired device for an online placement and refuses everything else", async () => {
    const runtime = await identity()
    const device = await identity()
    const signature = await device.sign(deviceAttachSigningBytes({ nonce: NONCE, runtimeId: runtime.id, deviceId: device.id }))
    const attach = { type: "attach" as const, runtimeId: runtime.id, deviceId: device.id, publicKey: device.publicKey, placementId: PLACEMENT.id, signature }
    const online = { expectedRuntimeId: runtime.id, nonce: NONCE, allowlist: new Set([device.id]), placementsOnline: new Set([PLACEMENT.id]) }
    expect(await admitDevice(attach, online)).toBe("admitted")
    expect(await admitDevice(attach, { ...online, allowlist: new Set() })).toBe("device_not_paired")
    expect(await admitDevice(attach, { ...online, placementsOnline: new Set() })).toBe("runtime_offline")
    expect(await admitDevice(attach, { ...online, nonce: "replayed" })).toBe("bad_signature")
    expect(await admitDevice({ ...attach, deviceId: "d".repeat(43) }, online)).toBe("bad_signature")
    // Presence needs the identity but no particular placement.
    expect(await admitDevice({ type: "presence", runtimeId: runtime.id, deviceId: device.id, publicKey: device.publicKey, signature }, { ...online, placementsOnline: new Set() })).toBe("admitted")
  })
})

describe("pairing admission", () => {
  test("admits one live window whose placement is online", () => {
    const frame = { type: "pair" as const, runtimeId: "r", windowId: "w" }
    const context = { expectedRuntimeId: "r", window: { placementId: PLACEMENT.id, socketId: "rt1", expiresAt: 2_000 }, now: 1_000, placementsOnline: new Set([PLACEMENT.id]) }
    expect(admitPairing(frame, context)).toBe("admitted")
    expect(admitPairing(frame, { ...context, now: 2_000 })).toBe("pairing_window_closed")
    expect(admitPairing(frame, { ...context, window: undefined })).toBe("pairing_window_closed")
    expect(admitPairing(frame, { ...context, placementsOnline: new Set() })).toBe("runtime_offline")
    expect(admitPairing({ ...frame, runtimeId: "other" }, context)).toBe("unknown_runtime")
  })
})

describe("rate limiter", () => {
  test("allows the limit within the window and refuses the next", () => {
    const limiter = new RateLimiter(3, 1_000)
    expect(limiter.admit("a", 0)).toBe(true)
    expect(limiter.admit("a", 10)).toBe(true)
    expect(limiter.admit("a", 20)).toBe(true)
    expect(limiter.admit("a", 30)).toBe(false)
    expect(limiter.admit("b", 30)).toBe(true)
    expect(limiter.admit("a", 1_050)).toBe(true)
  })
})

describe("silentAt", () => {
  const deadlineMs = RELAY_SILENCE_DEADLINE_MS
  test("a socket that has not pinged yet falls silent one deadline after it arrived", () => {
    expect(silentAt({ lastHeartbeatAt: undefined, acceptedAt: 1_000, deadlineMs })).toBe(1_000 + deadlineMs)
  })

  test("a socket is judged by its last ping once it has pinged, by the deadline it was given", () => {
    const acceptedAt = 1_000
    const pingedAt = acceptedAt + deadlineMs
    expect(silentAt({ lastHeartbeatAt: pingedAt, acceptedAt, deadlineMs })).toBe(pingedAt + deadlineMs)
    expect(silentAt({ lastHeartbeatAt: pingedAt, acceptedAt, deadlineMs: 3_000 })).toBe(pingedAt + 3_000)
  })
})

describe("placement presence", () => {
  const dormant = { ...PLACEMENT, state: "dormant" as const, version: "host" }
  const other = { ...PLACEMENT, id: "q".repeat(43), state: "dormant" as const }

  test("a runtime's live word beats the host's dormant one whatever the order", () => {
    const hostFirst = [{ socketId: "host", placement: dormant }, { socketId: "runtime", placement: PLACEMENT }]
    const runtimeFirst = [{ socketId: "runtime", placement: PLACEMENT }, { socketId: "host", placement: dormant }]
    expect(servingAnnouncement(hostFirst, PLACEMENT.id)?.socketId).toBe("runtime")
    expect(servingAnnouncement(runtimeFirst, PLACEMENT.id)?.socketId).toBe("runtime")
    expect(servedPlacements(runtimeFirst)).toEqual([PLACEMENT])
  })

  test("with only the host announcing, the placement is dormant and the host answers opens", () => {
    const announcements = [{ socketId: "host", placement: dormant }, { socketId: "host", placement: other }]
    expect(servingAnnouncement(announcements, PLACEMENT.id)?.socketId).toBe("host")
    expect(servedPlacements(announcements)).toEqual([dormant, other])
    expect(servingAnnouncement(announcements, "r".repeat(43))).toBeUndefined()
  })

  test("among equals the newest socket serves", () => {
    const announcements = [{ socketId: "older", placement: PLACEMENT }, { socketId: "newer", placement: { ...PLACEMENT, version: "0.0.9" } }]
    expect(servingAnnouncement(announcements, PLACEMENT.id)?.socketId).toBe("newer")
    expect(servedPlacements(announcements)).toEqual([{ ...PLACEMENT, version: "0.0.9" }])
  })
})

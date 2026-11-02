import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"

import { decodeRelayControlFrame, decodeRelayDeviceFrame, RELAY_HEARTBEAT_INTERVAL_MS, RELAY_PROTOCOL_VERSION, runtimeAttachSigningBytes } from "../../../src/protocol/modules/remote/relay-protocol.js"
import { startLocalRelay, type LocalRelay } from "./local-relay.js"
import { attachRuntime, closedEvent, deviceSocket, openChannel, pinging, relayIdentity, testRoute, textFrames, type Identity } from "./relay-sockets.js"

/** The limits that bound what one abuser costs the relay: the daily byte
 *  budget of a runtime id, the sockets one client IP may open, and the
 *  operator's admission lever. Each relay here runs the real Worker under
 *  workerd with the operator's variables set low enough to reach. */

const COUNTING_RELAY = join(import.meta.dir, "counting-relay.ts")
const PLACEMENT = "p".repeat(43)
const BUDGET_BYTES = 4096
/** Past the platform's 10 s idle window (`relay-hibernation.test.ts`). */
const IDLE_MS = 12_000
const today = () => new Date().toISOString().slice(0, 10)

/** Resolves with the size of the next binary frame `ws` receives. */
function nextBinary(ws: WebSocket): Promise<number> {
  ws.binaryType = "arraybuffer"
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) return
      ws.removeEventListener("message", onMessage)
      resolve(event.data.byteLength)
    }
    ws.addEventListener("message", onMessage)
  })
}

/** Sends `bytes` from one end of a channel and waits for the other end to have them. */
async function carry(from: WebSocket, to: WebSocket, bytes: number): Promise<void> {
  const received = nextBinary(to)
  from.send(new Uint8Array(bytes))
  expect(await received).toBe(bytes)
}

/** A device's attach to the placement, answered by the relay's next frame. */
async function attachOutcome(relay: LocalRelay, runtime: Identity, device: Identity) {
  const socket = await deviceSocket(relay.url, runtime, device, { type: "attach", placementId: PLACEMENT })
  return { ...socket, first: decodeRelayDeviceFrame(JSON.parse(await socket.frames.next())) }
}

describe("the daily byte budget of a runtime id", () => {
  let relay: LocalRelay

  beforeAll(async () => {
    relay = await startLocalRelay(COUNTING_RELAY, { vars: { RELAY_DAILY_GIB: String(BUDGET_BYTES / 1024 ** 3) } })
  })

  afterAll(async () => {
    await relay.miniflare.dispose()
  })

  test.concurrent("ends the channel that spends it, both ways counted, then refuses the next attach by name", async () => {
    const runtime = await relayIdentity()
    const device = await relayIdentity()
    const control = await attachRuntime(relay.url, runtime, device, PLACEMENT)
    const channel = await openChannel(relay.url, runtime, device, PLACEMENT, control, "")
    const channelClosed = closedEvent(channel.channel)
    await carry(channel.deviceWs, channel.channel, 3000)
    expect(channel.deviceWs.readyState).toBe(WebSocket.OPEN)
    // The frame that crosses the budget still arrives; then both sides end.
    await carry(channel.channel, channel.deviceWs, 2000)
    expect(await channel.deviceClosed).toMatchObject({ code: 1008, reason: "daily_budget" })
    expect(await channelClosed).toMatchObject({ code: 1008, reason: "daily_budget" })
    // The count outlives the channel.
    expect(await testRoute(relay, runtime, "keys")).toContain("pumped")

    const again = await attachOutcome(relay, runtime, device)
    expect(again.first).toEqual({ type: "rejected", reason: "daily_budget" })
    expect((await again.closed).reason).toBe("daily_budget")
    // The machine is never told to dial for a refused device.
    expect(await Promise.race([control.frames.next(), Bun.sleep(300).then(() => "none")])).toBe("none")
    control.ws.close(1000)
  }, 30_000)

  test.concurrent("reads the stored count of a new instance, and a count from an earlier UTC day is spent", async () => {
    // A seeded row stands in for the count an evicted instance stored.
    const spent = await relayIdentity()
    const device = await relayIdentity()
    await testRoute(relay, spent, "seed", { pumped: { day: today(), bytes: BUDGET_BYTES } })
    const control = await attachRuntime(relay.url, spent, device, PLACEMENT)
    expect((await attachOutcome(relay, spent, device)).first).toEqual({ type: "rejected", reason: "daily_budget" })
    control.ws.close(1000)

    const yesterday = await relayIdentity()
    await testRoute(relay, yesterday, "seed", { pumped: { day: "2000-01-01", bytes: BUDGET_BYTES * 10 } })
    const fresh = await attachRuntime(relay.url, yesterday, device, PLACEMENT)
    const channel = await openChannel(relay.url, yesterday, device, PLACEMENT, fresh, "")
    await carry(channel.deviceWs, channel.channel, 1000)
    for (const ws of [channel.deviceWs, channel.channel, fresh.ws]) ws.close(1000)
  }, 30_000)

  test.concurrent("counts what an open channel carried before the object hibernated, with no storage write", async () => {
    const runtime = await relayIdentity()
    const device = await relayIdentity()
    const control = await attachRuntime(relay.url, runtime, device, PLACEMENT)
    const channel = await openChannel(relay.url, runtime, device, PLACEMENT, control, "")
    const timers = [control.ws, channel.deviceWs, channel.channel].map((ws) => pinging(ws, RELAY_HEARTBEAT_INTERVAL_MS))
    try {
      await carry(channel.deviceWs, channel.channel, 3000)
      const before = await testRoute(relay, runtime, "constructions")
      await Bun.sleep(IDLE_MS)
      expect(await testRoute(relay, runtime, "keys")).not.toContain("pumped")
      await carry(channel.channel, channel.deviceWs, 2000)
      expect(await testRoute(relay, runtime, "constructions")).toBeGreaterThan(before)
      expect(await channel.deviceClosed).toMatchObject({ code: 1008, reason: "daily_budget" })
    } finally {
      for (const timer of timers) clearInterval(timer)
      control.ws.close(1000)
    }
  }, 30_000)
})

/** A machine's attach, answered by the relay's next frame after the challenge. */
async function runtimeAttachOutcome(relay: LocalRelay, runtime: Identity): Promise<string> {
  const ws = new WebSocket(`${relay.url}/runtime/${runtime.id}`)
  const frames = textFrames(ws)
  const challenge = decodeRelayControlFrame(JSON.parse(await frames.next()))
  if (challenge.type !== "challenge") throw new Error(`expected a challenge, got ${challenge.type}`)
  const placement = { id: PLACEMENT, projectLabel: "flywheel", version: "0.1.0", protocolVersion: 66, state: "live" }
  const signature = await runtime.sign(runtimeAttachSigningBytes({ nonce: challenge.nonce, runtimeId: runtime.id, placementId: PLACEMENT }))
  ws.send(JSON.stringify({ type: "attach", relayProtocolVersion: RELAY_PROTOCOL_VERSION, runtimeId: runtime.id, publicKey: runtime.publicKey, placement, devices: [], signature }))
  const answer = decodeRelayControlFrame(JSON.parse(await frames.next()))
  ws.close(1000)
  return answer.type === "rejected" ? `rejected ${answer.reason}` : answer.type
}

describe("the operator's admission lever", () => {
  test("`closed` refuses every runtime, and `existing` only a runtime id that never attached", async () => {
    const closed = await startLocalRelay(COUNTING_RELAY, { vars: { RELAY_ADMISSION: "closed" } })
    try {
      expect(await runtimeAttachOutcome(closed, await relayIdentity())).toBe("rejected admission_closed")
    } finally {
      await closed.miniflare.dispose()
    }
    const existing = await startLocalRelay(COUNTING_RELAY, { vars: { RELAY_ADMISSION: " Existing " } })
    try {
      expect(await runtimeAttachOutcome(existing, await relayIdentity())).toBe("rejected admission_closed")
      // A runtime id that attached before has its allowlist stored.
      const known = await relayIdentity()
      await testRoute(existing, known, "seed", { devices: [] })
      expect(await runtimeAttachOutcome(existing, known)).toBe("attached")
    } finally {
      await existing.miniflare.dispose()
    }
  }, 30_000)
})

describe("the sockets one client IP may open", () => {
  test("refuses the socket past the limit at the front door, for that address only, and never a client file or the health probe", async () => {
    const relay = await startLocalRelay(undefined, { socketsPerMinute: 3 })
    try {
      const runtime = await relayIdentity()
      const dial = (path: string, ip: string) => relay.miniflare.dispatchFetch(`${relay.origin}/${path}/${runtime.id}`, { headers: { Upgrade: "websocket", "CF-Connecting-IP": ip } })
      const admitted = []
      for (const path of ["runtime", "device", "channel"]) admitted.push(await dial(path, "192.0.2.1"))
      expect(admitted.map((response) => response.status)).toEqual([101, 101, 101])
      for (const response of admitted) response.webSocket?.accept()
      const refused = await dial("device", "192.0.2.1")
      expect(refused.status).toBe(429)
      expect(refused.headers.get("retry-after")).toBe("60")
      const other = await dial("device", "192.0.2.2")
      expect(other.status).toBe(101)
      other.webSocket?.accept()
      for (const response of [...admitted, other]) response.webSocket?.close(1000)
      expect((await relay.miniflare.dispatchFetch(`${relay.origin}/client/${runtime.id}/current`, { headers: { "CF-Connecting-IP": "192.0.2.1" } })).status).toBe(503)
      expect((await relay.miniflare.dispatchFetch(`${relay.origin}/health`, { headers: { "CF-Connecting-IP": "192.0.2.1" } })).status).toBe(200)
    } finally {
      await relay.miniflare.dispose()
    }
  }, 30_000)
})

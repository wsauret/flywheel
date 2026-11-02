import { expect, test } from "bun:test"
import { join } from "node:path"

import { decodeRelayControlFrame, decodeRelayDeviceFrame, RELAY_MIN_STATED_HEARTBEAT_MS, RELAY_MISSED_HEARTBEATS } from "../../../src/protocol/modules/remote/relay-protocol.js"
import type { Invocation } from "./counting-relay.js"
import { startLocalRelay } from "./local-relay.js"
import { attachRuntime, closedEvent, openChannel, pinging, relayIdentity, testRoute, textFrames } from "./relay-sockets.js"

/** The storage work the relay's object does. Every storage write is a moment
 *  in which a storage fault resets the object and ends every socket of the
 *  machine at once, so the object writes only what must outlive its sockets:
 *  the device allowlist when it changes, and the next sweep while a device
 *  is connected. Everything a socket stands for rides in its attachment. */

const COUNTING_RELAY = join(import.meta.dir, "counting-relay.ts")
const HEARTBEAT_MS = RELAY_MIN_STATED_HEARTBEAT_MS
const DEADLINE_MS = HEARTBEAT_MS * RELAY_MISSED_HEARTBEATS
const STATED = `?heartbeatMs=${HEARTBEAT_MS}`
const READS = new Set(["get", "list", "getAlarm"])

const writesOf = (invocation: Invocation) => invocation.calls.filter((call) => !READS.has(call))

test("a machine with no device connected arms no sweep, and the first device to arrive has its silent control socket closed at once", async () => {
  // A dead control socket that no device can reach hurts nobody: presence
  // judges liveness when a device asks, and the machine notices its own dead
  // link. So the object stays asleep, and a device arriving is what makes
  // the sweep look at the machine.
  const relay = await startLocalRelay(COUNTING_RELAY)
  try {
    const runtime = await relayIdentity()
    const device = await relayIdentity()
    const control = await attachRuntime(relay.url, runtime, device, "p".repeat(43), {}, STATED)
    await Bun.sleep(DEADLINE_MS + 1_000)
    expect(control.ws.readyState).toBe(WebSocket.OPEN)
    expect(await testRoute(relay, runtime, "alarm")).toEqual({ alarm: null })
    expect((await testRoute(relay, runtime, "invocations")).filter(({ handler }) => handler === "alarm")).toEqual([])

    const phone = new WebSocket(`${relay.url}/device/${runtime.id}`)
    const challenge = decodeRelayDeviceFrame(JSON.parse(await textFrames(phone).next()))
    expect(challenge.type).toBe("challenge")
    const arrivedAt = Date.now()
    const closed = await control.closed
    expect(closed.reason).toBe("heartbeat timeout")
    expect(closed.at - arrivedAt).toBeLessThan(1_500)
    phone.close(1000)
  } finally {
    await relay.miniflare.dispose()
  }
}, 30_000)

test("each sweep run writes only the next alarm, and messages and closes write nothing but a changed allowlist", async () => {
  const relay = await startLocalRelay(COUNTING_RELAY)
  const timers: ReturnType<typeof setInterval>[] = []
  try {
    const runtime = await relayIdentity()
    const device = await relayIdentity()
    const placementId = "p".repeat(43)
    const control = await attachRuntime(relay.url, runtime, device, placementId, {}, STATED)
    timers.push(pinging(control.ws, HEARTBEAT_MS / 2))
    // The same allowlist again is no change.
    control.ws.send(JSON.stringify({ type: "devices", devices: [device.id] }))
    const channel = await openChannel(relay.url, runtime, device, placementId, control, STATED)
    const channelPings = pinging(channel.channel, HEARTBEAT_MS / 2)
    await Bun.sleep(DEADLINE_MS + 500)
    expect(channel.deviceWs.readyState).toBe(WebSocket.OPEN)
    clearInterval(channelPings)
    expect((await channel.deviceClosed).reason).toBe("peer closed 1001: heartbeat timeout")
    await Bun.sleep(300)

    const invocations = await testRoute(relay, runtime, "invocations")
    const alarms = invocations.filter(({ handler }) => handler === "alarm")
    // Each run is due when the next watched socket could fall silent, never
    // again at once for a socket it already closed.
    expect(alarms.length).toBeGreaterThanOrEqual(2)
    expect(alarms.length).toBeLessThanOrEqual(8)
    // A run that finds no device left arms nothing.
    for (const alarm of alarms) expect([[], ["setAlarm"]]).toContainEqual(alarm.calls)
    expect(alarms.at(-1)?.calls).toEqual([])
    expect(invocations.filter(({ handler }) => handler === "close" || handler === "error").flatMap(({ calls }) => calls)).toEqual([])
    // The first attach stores the allowlist; nothing else a frame does is stored.
    expect(invocations.filter(({ handler }) => handler.startsWith("message:")).flatMap(writesOf)).toEqual(["put"])
    for (const arrival of invocations.filter(({ handler }) => handler.startsWith("fetch:"))) expect(writesOf(arrival).filter((call) => call !== "setAlarm")).toEqual([])
    for (const ws of [channel.channel, control.ws]) ws.close(1000)
  } finally {
    for (const timer of timers) clearInterval(timer)
    await relay.miniflare.dispose()
  }
}, 30_000)

test("a pairing window opens one channel, on the socket that announced it, and stores nothing", async () => {
  const relay = await startLocalRelay(COUNTING_RELAY)
  try {
    const runtime = await relayIdentity()
    const device = await relayIdentity()
    const control = await attachRuntime(relay.url, runtime, device, "p".repeat(43))
    const pair = async (windowId: string) => {
      const phone = new WebSocket(`${relay.url}/device/${runtime.id}`)
      const frames = textFrames(phone)
      const closed = closedEvent(phone)
      expect(decodeRelayDeviceFrame(JSON.parse(await frames.next())).type).toBe("challenge")
      phone.send(JSON.stringify({ type: "pair", runtimeId: runtime.id, windowId }))
      return { phone, frames, closed }
    }
    control.ws.send(JSON.stringify({ type: "pairing.open", windowId: "w".repeat(22), expiresAt: Date.now() + 60_000 }))
    control.ws.send(JSON.stringify({ type: "pairing.open", windowId: "x".repeat(22), expiresAt: Date.now() + 60_000 }))
    control.ws.send(JSON.stringify({ type: "pairing.close", windowId: "x".repeat(22) }))
    const first = await pair("w".repeat(22))
    const open = decodeRelayControlFrame(JSON.parse(await control.frames.next()))
    expect(open).toMatchObject({ type: "open", kind: "pairing", windowId: "w".repeat(22) })
    for (const windowId of ["w".repeat(22), "x".repeat(22)]) {
      const again = await pair(windowId)
      expect(decodeRelayDeviceFrame(JSON.parse(await again.frames.next()))).toEqual({ type: "rejected", reason: "pairing_window_closed" })
      await again.closed
    }
    const invocations = await testRoute(relay, runtime, "invocations")
    // Arming the sweep for the paired device's ticket is the one call.
    const ALARM = new Set(["getAlarm", "setAlarm"])
    expect(invocations.filter(({ handler }) => handler.startsWith("message:pair")).flatMap(({ calls }) => calls.filter((call) => !ALARM.has(call)))).toEqual([])
    for (const ws of [first.phone, control.ws]) ws.close(1000)
  } finally {
    await relay.miniflare.dispose()
  }
}, 30_000)

test("rows an earlier relay kept for tickets and pairing windows are deleted when a machine attaches", async () => {
  // Those rows named sockets the deploy that moved them already ended.
  const relay = await startLocalRelay(COUNTING_RELAY)
  try {
    const runtime = await relayIdentity()
    const device = await relayIdentity()
    await testRoute(relay, runtime, "seed", {
      devices: [device.id],
      "pending:old": { ticket: "t", deviceSocketId: "d", runtimeSocketId: "r", openedAt: 1, device: { placementId: "p".repeat(43), deviceId: device.id } },
      "window:old": { placementId: "p".repeat(43), socketId: "r", expiresAt: Date.now() + 60_000 },
    })
    const control = await attachRuntime(relay.url, runtime, device, "p".repeat(43))
    expect(await testRoute(relay, runtime, "keys")).toEqual(["devices"])
    control.ws.close(1000)
  } finally {
    await relay.miniflare.dispose()
  }
}, 30_000)

test("a storage error in the cleanup of an earlier relay's rows leaves the machine attached", async () => {
  // The cleanup is optional work on the attach path; a refusal there must
  // not park the machine's remote link.
  const relay = await startLocalRelay(COUNTING_RELAY)
  try {
    const runtime = await relayIdentity()
    const device = await relayIdentity()
    await testRoute(relay, runtime, "fail", ["list"])
    const control = await attachRuntime(relay.url, runtime, device, "p".repeat(43))
    const next = await Promise.race([control.frames.next(), Bun.sleep(500).then(() => "none")])
    expect(next).toBe("none")
    expect(control.ws.readyState).toBe(WebSocket.OPEN)
    expect((await testRoute(relay, runtime, "invocations")).find(({ handler }) => handler === "message:attach")?.calls).toContain("list")
    control.ws.close(1000)
  } finally {
    await relay.miniflare.dispose()
  }
}, 30_000)

test("a pairing window two control sockets announce opens one channel, on the newer socket", async () => {
  // A machine announces its open window again on each attach, so after a
  // silent drop the window is announced by the dead socket and the new one.
  const relay = await startLocalRelay(COUNTING_RELAY)
  try {
    const runtime = await relayIdentity()
    const device = await relayIdentity()
    const windowId = "w".repeat(22)
    const older = await attachRuntime(relay.url, runtime, device, "p".repeat(43))
    const newer = await attachRuntime(relay.url, runtime, device, "p".repeat(43))
    for (const control of [older, newer]) control.ws.send(JSON.stringify({ type: "pairing.open", windowId, expiresAt: Date.now() + 60_000 }))
    const pair = async () => {
      const phone = new WebSocket(`${relay.url}/device/${runtime.id}`)
      const frames = textFrames(phone)
      const closed = closedEvent(phone)
      expect(decodeRelayDeviceFrame(JSON.parse(await frames.next())).type).toBe("challenge")
      phone.send(JSON.stringify({ type: "pair", runtimeId: runtime.id, windowId }))
      return { phone, frames, closed }
    }
    const olderFrame = older.frames.next()
    const first = await pair()
    expect(decodeRelayControlFrame(JSON.parse(await newer.frames.next()))).toMatchObject({ type: "open", kind: "pairing", windowId })
    const again = await pair()
    expect(decodeRelayDeviceFrame(JSON.parse(await again.frames.next()))).toEqual({ type: "rejected", reason: "pairing_window_closed" })
    await again.closed
    expect(await Promise.race([olderFrame, Bun.sleep(300).then(() => "none")])).toBe("none")
    for (const ws of [first.phone, older.ws, newer.ws]) ws.close(1000)
  } finally {
    await relay.miniflare.dispose()
  }
}, 30_000)

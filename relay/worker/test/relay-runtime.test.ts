import { expect, spyOn, test } from "bun:test"
import { Effect, Stream } from "effect"
import { Socket } from "effect/socket"
import fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as relayChannel from "../../../src/protocol/modules/remote/relay-channel.js"
import { createRelayClient, type RelayClient } from "../../../src/protocol/modules/remote/relay-client.js"
import {
  decodeRelayControlFrame,
  decodeRelayDeviceFrame,
  deviceAttachSigningBytes,
  RELAY_MIN_STATED_HEARTBEAT_MS,
  RELAY_MISSED_HEARTBEATS,
  RELAY_PING,
} from "../../../src/protocol/modules/remote/relay-protocol.js"
import { startLocalRelay } from "./local-relay.js"
import { attachRuntime, openChannel, relayIdentity, textFrames } from "./relay-sockets.js"

test("the relay answers client close frames, including one without a status code", async () => {
  const relay = await startLocalRelay()
  try {
    for (const code of [1000, 4321, undefined]) {
      const ws = new WebSocket(`${relay.url}/device/${"r".repeat(43)}`)
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("message", () => resolve(), { once: true })
        ws.addEventListener("error", reject, { once: true })
      })
      const closed = new Promise<CloseEvent>((resolve) => { ws.addEventListener("close", resolve, { once: true }) })
      if (code === undefined) ws.close()
      else ws.close(code, "leaving")
      const event = await closed
      expect(event.code).toBe(code ?? 1000)
      expect(event.wasClean).toBe(true)
    }
  } finally {
    const originalRemove = fs.promises.rm
    const removalStarted = Promise.withResolvers<string>()
    const allowRemoval = Promise.withResolvers<void>()
    const remove = spyOn(fs.promises, "rm").mockImplementation(async (path, options) => {
      if (typeof path === "string" && path.startsWith(join(tmpdir(), "miniflare-"))) {
        removalStarted.resolve(path)
        await allowRemoval.promise
      }
      return originalRemove(path, options)
    })
    let disposed = false
    const disposal = relay.miniflare.dispose().then(() => { disposed = true })
    let temporaryDirectory: string
    try {
      temporaryDirectory = await removalStarted.promise
      expect(fs.existsSync(temporaryDirectory)).toBe(true)
      // Hold the real removal to expose an early dispose resolution regardless
      // of the filesystem's speed.
      await Bun.sleep(30)
      expect(disposed).toBe(false)
    } finally {
      allowRemoval.resolve()
      try {
        await disposal
      } finally {
        remove.mockRestore()
      }
    }
    expect(fs.existsSync(temporaryDirectory)).toBe(false)
  }
})

test.each(["dormant", "machine"] as const)("a phone hears a project's refusal on the %s control after starting", async (sender) => {
  const relay = await startLocalRelay()
  try {
    const runtime = await relayIdentity()
    const device = await relayIdentity()
    const placementId = "p".repeat(43)
    const control = await attachRuntime(relay.url, runtime, device, placementId, { state: "dormant" })
    const machine = sender === "machine" ? await attachRuntime(relay.url, runtime, device, runtime.id) : undefined
    const phone = new WebSocket(`${relay.url}/device/${runtime.id}`)
    const frames = textFrames(phone)
    const closed = new Promise<string>((resolve) => { phone.addEventListener("close", () => resolve("closed"), { once: true }) })
    try {
      const challenge = decodeRelayDeviceFrame(JSON.parse(await frames.next()))
      if (challenge.type !== "challenge") throw new Error(`expected a challenge, got ${challenge.type}`)
      const signature = await device.sign(deviceAttachSigningBytes({ nonce: challenge.nonce, runtimeId: runtime.id, deviceId: device.id }))
      phone.send(JSON.stringify({ type: "attach", runtimeId: runtime.id, deviceId: device.id, publicKey: device.publicKey, placementId, signature }))
      const open = decodeRelayControlFrame(JSON.parse(await control.frames.next()))
      if (open.type !== "open") throw new Error(`expected an open, got ${open.type}`)
      control.ws.send(JSON.stringify({ type: "decline", channelId: open.channelId, reason: "starting" }))
      expect(decodeRelayDeviceFrame(JSON.parse(await frames.next()))).toEqual({ type: "rejected", reason: "runtime_starting" })
      if (machine) {
        const released = new Promise<void>((resolve) => { control.ws.addEventListener("close", () => resolve(), { once: true }) })
        control.ws.close(1000)
        await released
      }
      const terminal = machine ?? control
      terminal.ws.send(JSON.stringify({ type: "decline", channelId: open.channelId, reason: "start_failed" }))
      const outcome = await Promise.race([frames.next(), closed])
      expect(outcome).not.toBe("closed")
      expect(decodeRelayDeviceFrame(JSON.parse(outcome))).toEqual({ type: "rejected", reason: "runtime_unavailable" })
    } finally {
      phone.close(1000)
      control.ws.close(1000)
      machine?.ws.close(1000)
    }
  } finally {
    await relay.miniflare.dispose()
  }
})

test("a machine that reports its side of a channel ended has the device closed at once, with the reason", async () => {
  // The edge can end a machine's channel socket without the relay object
  // ever hearing a close. The machine sees its socket end at once and says
  // so on its control socket, so the device dials again now rather than
  // sending into a dead lane until the channel's heartbeat deadline.
  const relay = await startLocalRelay()
  try {
    const runtime = await relayIdentity()
    const device = await relayIdentity()
    const placementId = "p".repeat(43)
    const control = await attachRuntime(relay.url, runtime, device, placementId)
    const orphaned = await openChannel(relay.url, runtime, device, placementId, control, "")
    const untouched = await openChannel(relay.url, runtime, device, placementId, control, "")
    // A channel the relay no longer holds is no reason to doubt the machine.
    control.ws.send(JSON.stringify({ type: "channel.ended", channelId: "gone" }))
    const reportedAt = Date.now()
    control.ws.send(JSON.stringify({ type: "channel.ended", channelId: orphaned.channelId }))
    const ended = await orphaned.deviceClosed
    expect(ended.code).toBe(1000)
    expect(ended.reason).toBe("peer closed 1006: the machine's side ended")
    expect(ended.at - reportedAt).toBeLessThan(1_000)
    await Bun.sleep(200)
    expect(untouched.deviceWs.readyState).toBe(WebSocket.OPEN)
    expect(control.ws.readyState).toBe(WebSocket.OPEN)
    for (const ws of [untouched.deviceWs, untouched.channel, orphaned.channel, control.ws]) ws.close(1000)
  } finally {
    await relay.miniflare.dispose()
  }
}, 30_000)

test("a machine that reports a channel ended before its accept arrived has the waiting device's channel opened again, and a late accept for the old one refused", async () => {
  // The edge can drop the machine's channel socket before this object reads
  // its accept. The device would wait on a ticket no live socket presents,
  // and an accept that arrived after the report would join it to a dead one.
  const relay = await startLocalRelay()
  try {
    const runtime = await relayIdentity()
    const device = await relayIdentity()
    const placementId = "p".repeat(43)
    const control = await attachRuntime(relay.url, runtime, device, placementId)
    const deviceWs = new WebSocket(`${relay.url}/device/${runtime.id}`)
    const deviceFrames = textFrames(deviceWs)
    const challenge = decodeRelayDeviceFrame(JSON.parse(await deviceFrames.next()))
    if (challenge.type !== "challenge") throw new Error(`expected a challenge, got ${challenge.type}`)
    const signature = await device.sign(deviceAttachSigningBytes({ nonce: challenge.nonce, runtimeId: runtime.id, deviceId: device.id }))
    deviceWs.send(JSON.stringify({ type: "attach", runtimeId: runtime.id, deviceId: device.id, publicKey: device.publicKey, placementId, signature }))
    const first = decodeRelayControlFrame(JSON.parse(await control.frames.next()))
    if (first.type !== "open") throw new Error(`expected an open, got ${first.type}`)

    control.ws.send(JSON.stringify({ type: "channel.ended", channelId: first.channelId }))
    const second = decodeRelayControlFrame(JSON.parse(await control.frames.next()))
    if (second.type !== "open") throw new Error(`expected an open, got ${second.type}`)
    expect(second.channelId).not.toBe(first.channelId)
    expect(second.deviceId).toBe(device.id)

    const dial = async (open: typeof first) => {
      const channel = new WebSocket(`${relay.url}/channel/${runtime.id}`)
      await new Promise((resolve) => { channel.addEventListener("open", resolve, { once: true }) })
      const closed = new Promise<{ code: number; reason: string }>((resolve) => { channel.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true }) })
      channel.send(JSON.stringify({ type: "accept", runtimeId: runtime.id, channelId: open.channelId, ticket: open.ticket }))
      return { channel, closed }
    }
    const late = await dial(first)
    expect(await late.closed).toEqual({ code: 1008, reason: "unknown channel" })
    const fresh = await dial(second)
    expect(decodeRelayDeviceFrame(JSON.parse(await deviceFrames.next())).type).toBe("attached")
    for (const ws of [fresh.channel, deviceWs, control.ws]) ws.close(1000)
  } finally {
    await relay.miniflare.dispose()
  }
}, 30_000)

test("a data channel that states its heartbeat and stops pinging is closed, and its device hears why at once", async () => {
  // A machine whose link to the relay died without a close cannot tell the
  // relay; only its silence can. The relay holds the machine's side of the
  // channel to the heartbeat it stated, so the device learns within that
  // deadline instead of waiting out the runtime protocol's own minute.
  const relay = await startLocalRelay()
  try {
    const runtime = await relayIdentity()
    const device = await relayIdentity()
    const placementId = "p".repeat(43)
    const control = await attachRuntime(relay.url, runtime, device, placementId)
    const heartbeatMs = RELAY_MIN_STATED_HEARTBEAT_MS
    const deadlineMs = heartbeatMs * RELAY_MISSED_HEARTBEATS
    const silent = await openChannel(relay.url, runtime, device, placementId, control, `?heartbeatMs=${heartbeatMs}`)
    const pinging = await openChannel(relay.url, runtime, device, placementId, control, `?heartbeatMs=${heartbeatMs}`)
    // A runtime released before channels stated a heartbeat is held to the
    // rule it was built for: its channel lasts while its device does.
    const unstated = await openChannel(relay.url, runtime, device, placementId, control, "")
    const silentSince = Date.now()
    const pinger = setInterval(() => pinging.channel.send(RELAY_PING), heartbeatMs / 2)
    try {
      const ended = await silent.deviceClosed
      expect(ended.code).toBe(1000)
      expect(ended.reason).toBe("peer closed 1001: heartbeat timeout")
      expect(ended.at - silentSince).toBeGreaterThanOrEqual(deadlineMs - 100)
      expect(ended.at - silentSince).toBeLessThan(deadlineMs + 1500)
      await Bun.sleep(deadlineMs)
      expect(pinging.deviceWs.readyState).toBe(WebSocket.OPEN)
      expect(unstated.deviceWs.readyState).toBe(WebSocket.OPEN)
    } finally {
      clearInterval(pinger)
      for (const ws of [pinging.deviceWs, pinging.channel, unstated.deviceWs, unstated.channel, silent.channel, control.ws]) ws.close(1000)
    }
  } finally {
    await relay.miniflare.dispose()
  }
}, 30_000)

test("a stated socket that keeps sending frames is live though its pings wait behind them", async () => {
  // A ping queues behind every byte already on its socket, so a machine
  // sending a large body over a slow link delivers its pings late. The frames
  // arriving are themselves proof the link works.
  const relay = await startLocalRelay()
  try {
    const runtime = await relayIdentity()
    const device = await relayIdentity()
    const placementId = "p".repeat(43)
    const control = await attachRuntime(relay.url, runtime, device, placementId)
    const heartbeatMs = RELAY_MIN_STATED_HEARTBEAT_MS
    const deadlineMs = heartbeatMs * RELAY_MISSED_HEARTBEATS
    const busy = await openChannel(relay.url, runtime, device, placementId, control, `?heartbeatMs=${heartbeatMs}`)
    let received = 0
    busy.deviceWs.addEventListener("message", (event) => {
      if (typeof event.data !== "string") received += 1
    })
    const sender = setInterval(() => busy.channel.send(new Uint8Array(1024)), heartbeatMs / 2)
    try {
      await Bun.sleep(deadlineMs * 2)
      expect(busy.deviceWs.readyState).toBe(WebSocket.OPEN)
      expect(received).toBeGreaterThan(0)
    } finally {
      clearInterval(sender)
    }
    // Once the frames stop too, the socket is silent and the sweep closes it.
    const ended = await busy.deviceClosed
    expect(ended.reason).toBe("peer closed 1001: heartbeat timeout")
    for (const ws of [busy.channel, control.ws]) ws.close(1000)
  } finally {
    await relay.miniflare.dispose()
  }
}, 30_000)

test("a device parked on a control socket that went silent is opened by the control socket that replaces it", async () => {
  // When a machine's whole link dies, its control socket and its data
  // channels go silent together. The device the relay swept dials again at
  // once and its `open` reaches the dead control socket, which the relay
  // still counts as live. The machine attaches a fresh control socket once
  // its own heartbeat notices; the parked device must follow its placement
  // there, not wait out the pending ticket.
  const relay = await startLocalRelay()
  try {
    const runtime = await relayIdentity()
    const device = await relayIdentity()
    const placementId = "p".repeat(43)
    const stale = await attachRuntime(relay.url, runtime, device, placementId)
    const deviceWs = new WebSocket(`${relay.url}/device/${runtime.id}`)
    const deviceFrames = textFrames(deviceWs)
    const challenge = decodeRelayDeviceFrame(JSON.parse(await deviceFrames.next()))
    if (challenge.type !== "challenge") throw new Error(`expected a challenge, got ${challenge.type}`)
    const signature = await device.sign(deviceAttachSigningBytes({ nonce: challenge.nonce, runtimeId: runtime.id, deviceId: device.id }))
    deviceWs.send(JSON.stringify({ type: "attach", runtimeId: runtime.id, deviceId: device.id, publicKey: device.publicKey, placementId, signature }))
    const lost = decodeRelayControlFrame(JSON.parse(await stale.frames.next()))
    expect(lost.type).toBe("open")
    const fresh = await attachRuntime(relay.url, runtime, device, placementId)
    const replacedAt = Date.now()
    const open = decodeRelayControlFrame(JSON.parse(await fresh.frames.next()))
    if (open.type !== "open") throw new Error(`expected an open, got ${open.type}`)
    expect(open).toEqual(lost)
    const channel = new WebSocket(`${relay.url}/channel/${runtime.id}`)
    await new Promise((resolve) => { channel.addEventListener("open", resolve, { once: true }) })
    channel.send(JSON.stringify({ type: "accept", runtimeId: runtime.id, channelId: open.channelId, ticket: open.ticket }))
    expect(decodeRelayDeviceFrame(JSON.parse(await deviceFrames.next())).type).toBe("attached")
    expect(Date.now() - replacedAt).toBeLessThan(2_000)
    for (const ws of [deviceWs, channel, stale.ws, fresh.ws]) ws.close(1000)
  } finally {
    await relay.miniflare.dispose()
  }
}, 30_000)

test("a starting phone attaches before presence arrives and keeps its returned channel", async () => {
  const relay = await startLocalRelay()
  const sockets: WebSocket[] = []
  const runtime = await relayIdentity()
  const device = await relayIdentity()
  const placementId = "p".repeat(43)
  let presence: Parameters<typeof relayChannel.watchPresence>[3] | undefined
  const watch = spyOn(relayChannel, "watchPresence").mockImplementation((_url, _id, _device, onPlacements) => {
    presence = onPlacements
    return { close() {} }
  })
  const opened = Promise.withResolvers<relayChannel.DeviceChannel>()
  const realAttach = relayChannel.attachDeviceChannel
  const attach = spyOn(relayChannel, "attachDeviceChannel").mockImplementation(async (...args) => {
    const result = await realAttach(...args)
    opened.resolve(result)
    return result
  })
  let client: RelayClient | undefined
  let run: Promise<unknown> | undefined
  try {
    const dormant = await attachRuntime(relay.url, runtime, device, placementId, { state: "dormant" })
    sockets.push(dormant.ws)
    const selection = { runtimeId: runtime.id, placementId }
    client = await createRelayClient({
      device: { keyPair: device.keyPair, deviceId: device.id, publicKey: device.raw },
      label: () => "Phone",
      setLabel: async () => {},
      runtimes: async () => [{ runtimeId: runtime.id, publicKey: runtime.publicKey, relay: relay.url, label: "Machine", pairedAt: 0 }],
      putRuntime: async () => {},
      removeRuntime: async () => {},
      selection: async () => selection,
      setSelection: async () => {},
    })
    const placement = { id: placementId, projectLabel: "flywheel", version: "0.1.0", protocolVersion: 66 }
    presence!([{ ...placement, state: "dormant" }])
    const starting = Promise.withResolvers<void>()
    client.onChange((snapshot) => { if (snapshot.start?.status === "starting") starting.resolve() })
    run = Effect.runPromiseExit(Effect.gen(function*() {
      const socket = yield* Socket.Socket
      yield* Stream.runDrain(Socket.toStream(socket))
    }).pipe(Effect.provide(client.socket)))
    const initialOpen = decodeRelayControlFrame(JSON.parse(await dormant.frames.next()))
    if (initialOpen.type !== "open") throw new Error(`expected an open, got ${initialOpen.type}`)
    dormant.ws.send(JSON.stringify({ type: "decline", channelId: initialOpen.channelId, reason: "starting" }))
    await starting.promise
    const serving = await attachRuntime(relay.url, runtime, device, placementId)
    sockets.push(serving.ws)
    const followed = decodeRelayControlFrame(JSON.parse(await serving.frames.next()))
    expect(followed).toEqual(initialOpen)
    const data = new WebSocket(`${relay.url}/channel/${runtime.id}`)
    data.binaryType = "arraybuffer"
    sockets.push(data)
    const binary = Promise.withResolvers<void>()
    data.addEventListener("message", (event) => { if (typeof event.data !== "string") binary.resolve() }, { once: true })
    await new Promise((resolve) => { data.addEventListener("open", resolve, { once: true }) })
    data.send(JSON.stringify({ type: "accept", runtimeId: runtime.id, channelId: initialOpen.channelId, ticket: initialOpen.ticket }))
    const result = await opened.promise
    sockets.push(result.ws)
    // The sealed hello proves the client has acquired the returned channel.
    await binary.promise
    const startAtAttach = client.snapshot().start
    presence!([{ ...placement, state: "live" }])
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(result.ws.readyState).toBe(WebSocket.OPEN)
    expect(startAtAttach).toBeUndefined()
    const delivered = Promise.withResolvers<unknown>()
    data.addEventListener("message", (event) => delivered.resolve(event.data), { once: true })
    result.ws.send(new Uint8Array([1, 2, 3]))
    expect(await delivered.promise).toEqual(new Uint8Array([1, 2, 3]).buffer)
    expect(attach).toHaveBeenCalledTimes(1)
  } finally {
    client?.close()
    for (const ws of sockets) ws.close(1000)
    if (run) await run
    watch.mockRestore()
    attach.mockRestore()
    await relay.miniflare.dispose()
  }
}, 15_000)

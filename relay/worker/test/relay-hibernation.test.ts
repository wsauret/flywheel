import { afterAll, beforeAll, expect, test } from "bun:test"
import { join } from "node:path"

import { decodeRelayControlFrame, decodeRelayDeviceFrame, encodeAssetChunk, RELAY_HEARTBEAT_INTERVAL_MS, RELAY_MIN_STATED_HEARTBEAT_MS, RELAY_MISSED_HEARTBEATS, RELAY_PONG } from "../../../src/protocol/modules/remote/relay-protocol.js"
import { startLocalRelay, type LocalRelay } from "./local-relay.js"
import { attachRuntime, deviceSocket, openChannel, pinging, relayIdentity, testRoute, textFrames, type Announced, type Identity } from "./relay-sockets.js"

/** The relay's object hibernates in every state it can sit in. Cloudflare
 *  bills a Durable Object for each second it runs or sits in memory unable
 *  to hibernate, and evicts one that has handled nothing for 10 s while its
 *  hibernatable sockets stay open. Pings with the exact `RELAY_PING` string
 *  are answered by the platform and do not count as work. workerd under
 *  Miniflare does the same, so each test drives the real relay into one
 *  state, keeps every socket pinging past that window, then sends a frame a
 *  handler answers and expects the object to have been constructed again.
 *  Anything that keeps the object in memory fails here: a pending timer,
 *  unfinished I/O or `waitUntil`, an outbound connection, or a socket
 *  outside the hibernation API.
 *
 *  Every socket states no heartbeat unless its test is about the sweep. A
 *  device that is connected arms the sweep at the earliest socket deadline,
 *  and a stated heartbeat of a few seconds would run it inside the idle
 *  window; with none stated the first run is 75 s away. */

const COUNTING_RELAY = join(import.meta.dir, "counting-relay.ts")
/** Past the platform's 10 s idle window. */
const IDLE_MS = 12_000
const TIMEOUT_MS = 30_000
const PLACEMENT = "p".repeat(43)
const CLIENT_IDENTITY = "c".repeat(64)
const SWEEP_HEARTBEAT_MS = RELAY_MIN_STATED_HEARTBEAT_MS
const SWEEP_STATED = `?heartbeatMs=${SWEEP_HEARTBEAT_MS}`

let relay: LocalRelay

beforeAll(async () => {
  relay = await startLocalRelay(COUNTING_RELAY)
})

afterAll(async () => {
  await relay.miniflare.dispose()
})

/** Keeps `ws` pinging until it closes, as every client does. */
function heartbeat(ws: WebSocket, intervalMs = RELAY_HEARTBEAT_INTERVAL_MS): void {
  const timer = pinging(ws, intervalMs)
  ws.addEventListener("close", () => clearInterval(timer), { once: true })
}

/** One test's sockets, each pinging from the moment it is held and closed
 *  when the test ends. */
function sockets() {
  const held: WebSocket[] = []
  return {
    hold<T extends { readonly ws: WebSocket }>(socket: T, intervalMs?: number): T {
      held.push(socket.ws)
      heartbeat(socket.ws, intervalMs)
      return socket
    },
    [Symbol.dispose]() {
      for (const ws of held) ws.close(1000)
    },
  }
}

const constructions = (runtime: Identity) => testRoute(relay, runtime, "constructions")

/** Holds the object of `runtime` idle past the platform's window, then runs
 *  `poke`, and expects the object to have been constructed again. */
async function expectHibernates(runtime: Identity, poke: () => Promise<void>): Promise<void> {
  const before = await constructions(runtime)
  await Bun.sleep(IDLE_MS)
  await poke()
  expect(await constructions(runtime)).toBeGreaterThan(before)
}

/** A ping that is not byte for byte `RELAY_PING`, so the platform passes it
 *  to the object's handler, which answers it. */
async function answersPing(ws: WebSocket): Promise<void> {
  const answered = new Promise<void>((resolve) => {
    ws.addEventListener("message", (event) => {
      if (event.data === RELAY_PONG) resolve()
    })
  })
  ws.send(`{"type": "ping"}`)
  await answered
}

/** A machine attached as `runtime`, with `device` on its allowlist. */
async function attachMachine(runtime: Identity, device: Identity, announced: Announced = {}, query = "") {
  return await attachRuntime(relay.url, runtime, device, PLACEMENT, announced, query)
}

function nextBinary(ws: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) return
      ws.removeEventListener("message", onMessage)
      resolve(new Uint8Array(event.data))
    }
    ws.addEventListener("message", onMessage)
  })
}

async function expectRelaysBothWays(device: WebSocket, channel: WebSocket): Promise<void> {
  for (const [from, to, byte] of [[device, channel, 1], [channel, device, 2]] as const) {
    const received = nextBinary(to)
    from.send(new Uint8Array([byte]))
    expect(await received).toEqual(new Uint8Array([byte]))
  }
}

/** Asks for the machine's client file as a phone does, and resolves with the
 *  phone's response and the request the machine was sent. */
async function requestClientFile(machine: Awaited<ReturnType<typeof attachMachine>>, runtime: Identity) {
  const response = fetch(`${relay.origin}/client/${runtime.id}/${CLIENT_IDENTITY}/phone/webview.js`, { headers: { "Accept-Encoding": "identity" } })
  const request = decodeRelayControlFrame(JSON.parse(await machine.frames.next()))
  if (request.type !== "asset.request") throw new Error(`expected an asset request, got ${request.type}`)
  machine.ws.send(JSON.stringify({ type: "asset.head", requestId: request.requestId, contentType: "text/javascript; charset=utf-8" }))
  machine.ws.send(encodeAssetChunk(request.requestId, new Uint8Array([1, 2, 3])))
  return { response: await response, requestId: request.requestId }
}

test.concurrent("a machine's control socket left idle after its attach lets the object hibernate", async () => {
  using held = sockets()
  const runtime = await relayIdentity()
  const machine = held.hold(await attachMachine(runtime, await relayIdentity()))
  await expectHibernates(runtime, () => answersPing(machine.ws))
}, TIMEOUT_MS)

test.concurrent("a device watching presence lets the object hibernate", async () => {
  using held = sockets()
  const runtime = await relayIdentity()
  const device = await relayIdentity()
  held.hold(await attachMachine(runtime, device))
  const phone = held.hold(await deviceSocket(relay.url, runtime, device, { type: "presence" }))
  expect(decodeRelayDeviceFrame(JSON.parse(await phone.frames.next())).type).toBe("presence")
  await expectHibernates(runtime, () => answersPing(phone.ws))
}, TIMEOUT_MS)

test.concurrent("an attached data channel lets the object hibernate after data flowed, and relays both ways after it woke", async () => {
  using held = sockets()
  const runtime = await relayIdentity()
  const device = await relayIdentity()
  const machine = held.hold(await attachMachine(runtime, device))
  const channel = await openChannel(relay.url, runtime, device, PLACEMENT, machine, "")
  held.hold({ ws: channel.deviceWs })
  held.hold({ ws: channel.channel })
  channel.deviceWs.binaryType = "arraybuffer"
  channel.channel.binaryType = "arraybuffer"
  await expectRelaysBothWays(channel.deviceWs, channel.channel)
  await expectHibernates(runtime, () => expectRelaysBothWays(channel.deviceWs, channel.channel))
}, TIMEOUT_MS)

test.concurrent("a sweep run leaves the object free to hibernate", async () => {
  // A connected device arms the sweep, and a run that still finds one arms
  // the next; the run after the device leaves arms nothing.
  using held = sockets()
  const runtime = await relayIdentity()
  const device = await relayIdentity()
  const machine = held.hold(await attachMachine(runtime, device, {}, SWEEP_STATED), SWEEP_HEARTBEAT_MS / 2)
  const phone = held.hold(await deviceSocket(relay.url, runtime, device, { type: "presence" }, SWEEP_STATED), SWEEP_HEARTBEAT_MS / 2)
  expect(decodeRelayDeviceFrame(JSON.parse(await phone.frames.next())).type).toBe("presence")
  const sweepAfter = async () => (await testRoute(relay, runtime, "alarm")).alarm
  const armed = await sweepAfter()
  expect(armed).toBeNumber()
  await Bun.sleep(SWEEP_HEARTBEAT_MS * RELAY_MISSED_HEARTBEATS + 1_000)
  expect(await sweepAfter()).toBeGreaterThan(armed!)
  phone.ws.close(1000)
  await Bun.sleep(SWEEP_HEARTBEAT_MS * RELAY_MISSED_HEARTBEATS + 1_000)
  expect(await sweepAfter()).toBeNull()
  await expectHibernates(runtime, () => answersPing(machine.ws))
}, TIMEOUT_MS)

test.concurrent("an open pairing window lets the object hibernate, and a phone pairs through it after the object woke", async () => {
  using held = sockets()
  const runtime = await relayIdentity()
  const machine = held.hold(await attachMachine(runtime, await relayIdentity()))
  const windowId = "w".repeat(22)
  machine.ws.send(JSON.stringify({ type: "pairing.open", windowId, expiresAt: Date.now() + 60_000 }))
  await expectHibernates(runtime, async () => {
    const phone = new WebSocket(`${relay.url}/device/${runtime.id}`)
    const frames = textFrames(phone)
    expect(decodeRelayDeviceFrame(JSON.parse(await frames.next())).type).toBe("challenge")
    held.hold({ ws: phone })
    phone.send(JSON.stringify({ type: "pair", runtimeId: runtime.id, windowId }))
    expect(decodeRelayControlFrame(JSON.parse(await machine.frames.next()))).toMatchObject({ type: "open", kind: "pairing", windowId })
  })
}, TIMEOUT_MS)

test.concurrent("a client file transfer that completed leaves the object free to hibernate", async () => {
  using held = sockets()
  const runtime = await relayIdentity()
  const machine = held.hold(await attachMachine(runtime, await relayIdentity(), { clientIdentity: CLIENT_IDENTITY }))
  const { response, requestId } = await requestClientFile(machine, runtime)
  machine.ws.send(JSON.stringify({ type: "asset.end", requestId }))
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  await expectHibernates(runtime, () => answersPing(machine.ws))
}, TIMEOUT_MS)

test.concurrent("a client file transfer the machine abandoned leaves the object free to hibernate once the relay gives up on it", async () => {
  using held = sockets()
  const runtime = await relayIdentity()
  const machine = held.hold(await attachMachine(runtime, await relayIdentity(), { clientIdentity: CLIENT_IDENTITY }))
  const { response } = await requestClientFile(machine, runtime)
  // The machine never ends the file, so the phone's body ends only when the
  // relay gives up on a machine silent for its asset silence window.
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  await expectHibernates(runtime, () => answersPing(machine.ws))
}, TIMEOUT_MS + 15_000)

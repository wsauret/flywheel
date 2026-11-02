import { expect } from "bun:test"

import {
  asKeyPair,
  decodeRelayControlFrame,
  decodeRelayDeviceFrame,
  deviceAttachSigningBytes,
  keyDigest,
  ownedBytes,
  RELAY_PING,
  RELAY_PONG,
  RELAY_PROTOCOL_VERSION,
  runtimeAttachSigningBytes,
  toBase64Url,
} from "../../../src/protocol/modules/remote/relay-protocol.js"
import type { Invocation } from "./counting-relay.js"
import type { LocalRelay } from "./local-relay.js"

/** The two ends of the relay as the relay tests drive them: a runtime
 *  identity, a machine's control socket, a device socket, and a data channel,
 *  each spoken frame by frame. */

/** A runtime identity as the remote module holds one: a key, its digest as
 *  the runtime id, and a signer. */
export async function relayIdentity() {
  const pair = asKeyPair(await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]))
  const exported = await crypto.subtle.exportKey("raw", pair.publicKey)
  if (!(exported instanceof ArrayBuffer)) throw new Error("expected raw key bytes")
  const publicKey = new Uint8Array(exported)
  return {
    keyPair: pair,
    raw: publicKey,
    id: await keyDigest(publicKey),
    publicKey: toBase64Url(publicKey),
    sign: async (data: Uint8Array) => toBase64Url(new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, ownedBytes(data)))),
  }
}

export type Identity = Awaited<ReturnType<typeof relayIdentity>>

/** What each action of the counting relay's test route answers. */
interface TestRouteAnswers {
  readonly invocations: Invocation[]
  readonly constructions: number
  readonly alarm: { alarm: number | null }
  readonly keys: string[]
  readonly fail: undefined
  readonly seed: undefined
}

function wrongAnswer(action: string): Error {
  return new Error(`the counting relay's ${action} route answered an unexpected shape`)
}

function stringsOf(value: unknown, action: string): string[] {
  if (!Array.isArray(value)) throw wrongAnswer(action)
  return value.map((item) => { if (typeof item !== "string") throw wrongAnswer(action); return item })
}

/** One reader per action, each checking the answer it returns. */
type TestRouteReaders = { readonly [A in keyof TestRouteAnswers]: (value: unknown) => TestRouteAnswers[A] }

const TEST_ROUTE_ANSWERS: TestRouteReaders = {
  invocations: (value) => {
    if (!Array.isArray(value)) throw wrongAnswer("invocations")
    return value.map((item: unknown) => {
      if (typeof item !== "object" || item === null || !("handler" in item) || typeof item.handler !== "string" || !("calls" in item)) throw wrongAnswer("invocations")
      return { handler: item.handler, calls: stringsOf(item.calls, "invocations") }
    })
  },
  constructions: (value) => { if (typeof value !== "number") throw wrongAnswer("constructions"); return value },
  alarm: (value) => {
    if (typeof value !== "object" || value === null || !("alarm" in value)) throw wrongAnswer("alarm")
    const { alarm } = value
    if (alarm !== null && typeof alarm !== "number") throw wrongAnswer("alarm")
    return { alarm }
  },
  keys: (value) => stringsOf(value, "keys"),
  fail: () => undefined,
  seed: () => undefined,
}

/** Reads or changes the object of `runtime` through the counting relay's
 *  test route (`counting-relay.ts`); a `body` makes it a POST. Throws when the
 *  route answers a shape other than the one its action states. */
export async function testRoute<A extends keyof TestRouteAnswers>(relay: LocalRelay, runtime: Identity, action: A, body?: unknown): Promise<TestRouteAnswers[A]> {
  const response = await fetch(`${relay.origin}/__relay-test/${runtime.id}/${action}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) })
  const answer: unknown = await response.json()
  return TEST_ROUTE_ANSWERS[action](answer)
}

/** Pings `ws` now and every `intervalMs`, with the exact string the platform
 *  answers without waking the object. */
export function pinging(ws: WebSocket, intervalMs: number): ReturnType<typeof setInterval> {
  ws.send(RELAY_PING)
  return setInterval(() => ws.send(RELAY_PING), intervalMs)
}

/** The text frames a socket receives, read one at a time in arrival order.
 *  The relay's answers to the socket's own pings are not among them. */
export interface TextFrames {
  next(): Promise<string>
}

export function textFrames(ws: WebSocket): TextFrames {
  const queue: string[] = []
  const waiting: ((frame: string) => void)[] = []
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string" || event.data === RELAY_PONG) return
    const waiter = waiting.shift()
    if (waiter) waiter(event.data)
    else queue.push(event.data)
  })
  return { next: () => queue.length > 0 ? Promise.resolve(queue.shift()!) : new Promise((resolve) => { waiting.push(resolve) }) }
}

/** How and when a socket closed. */
export function closedEvent(ws: WebSocket): Promise<{ code: number; reason: string; at: number }> {
  return new Promise((resolve) => {
    ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason, at: Date.now() }), { once: true })
  })
}

/** What a placement announces beyond its id: live unless `state` says
 *  dormant, and the web client it serves when `clientIdentity` names one. */
export interface Announced {
  readonly state?: "live" | "dormant"
  readonly clientIdentity?: string
}

/** A machine's control socket, attached and announcing one placement.
 *  `query` may state a heartbeat, as `?heartbeatMs=5000`. */
export async function attachRuntime(url: string, runtime: Identity, device: Identity, placementId: string, announced: Announced = {}, query = "") {
  const ws = new WebSocket(`${url}/runtime/${runtime.id}${query}`)
  const frames = textFrames(ws)
  const closed = closedEvent(ws)
  const challenge = decodeRelayControlFrame(JSON.parse(await frames.next()))
  if (challenge.type !== "challenge") throw new Error(`expected a challenge, got ${challenge.type}`)
  const placement = { id: placementId, projectLabel: "flywheel", version: "0.1.0", protocolVersion: 66, state: "live", ...announced }
  const signature = await runtime.sign(runtimeAttachSigningBytes({ nonce: challenge.nonce, runtimeId: runtime.id, placementId }))
  ws.send(JSON.stringify({ type: "attach", relayProtocolVersion: RELAY_PROTOCOL_VERSION, runtimeId: runtime.id, publicKey: runtime.publicKey, placement, devices: [device.id], signature }))
  expect(decodeRelayControlFrame(JSON.parse(await frames.next())).type).toBe("attached")
  return { ws, frames, closed }
}

/** A device socket that has read its challenge and sent a signed `request`:
 *  an attach to a placement, or a request to watch presence. `query` may
 *  state a heartbeat. */
export async function deviceSocket(url: string, runtime: Identity, device: Identity, request: { readonly type: "attach"; readonly placementId: string } | { readonly type: "presence" }, query = "") {
  const ws = new WebSocket(`${url}/device/${runtime.id}${query}`)
  const frames = textFrames(ws)
  const closed = closedEvent(ws)
  const challenge = decodeRelayDeviceFrame(JSON.parse(await frames.next()))
  if (challenge.type !== "challenge") throw new Error(`expected a challenge, got ${challenge.type}`)
  const signature = await device.sign(deviceAttachSigningBytes({ nonce: challenge.nonce, runtimeId: runtime.id, deviceId: device.id }))
  ws.send(JSON.stringify({ ...request, runtimeId: runtime.id, deviceId: device.id, publicKey: device.publicKey, signature }))
  return { ws, frames, closed }
}

/** One device attached to the placement through a data channel the machine
 *  dialed with `channelQuery`, which may state a heartbeat. */
export async function openChannel(url: string, runtime: Identity, device: Identity, placementId: string, control: Awaited<ReturnType<typeof attachRuntime>>, channelQuery: string) {
  const attached = await deviceSocket(url, runtime, device, { type: "attach", placementId })
  const open = decodeRelayControlFrame(JSON.parse(await control.frames.next()))
  if (open.type !== "open") throw new Error(`expected an open, got ${open.type}`)
  const channel = new WebSocket(`${url}/channel/${runtime.id}${channelQuery}`)
  await new Promise((resolve) => {
    channel.addEventListener("open", resolve, { once: true })
  })
  channel.send(JSON.stringify({ type: "accept", runtimeId: runtime.id, channelId: open.channelId, ticket: open.ticket }))
  expect(decodeRelayDeviceFrame(JSON.parse(await attached.frames.next())).type).toBe("attached")
  return { deviceWs: attached.ws, deviceFrames: attached.frames, deviceClosed: attached.closed, channel, channelId: open.channelId }
}

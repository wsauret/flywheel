import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { Socket } from "effect/unstable/socket"

import { keepAlive, relayChannelStreams, type HeartbeatClock } from "../../../../../src/protocol/modules/remote/relay-channel.js"
import { RELAY_PING, RELAY_PONG } from "../../../../../src/protocol/modules/remote/relay-protocol.js"
import { manualHeartbeatClock } from "../../../../helpers/heartbeat-clock.js"

/** The heartbeat that makes silence on a relay text lane evidence. A stub
 *  server stands in for the relay's auto-response: it answers pings while
 *  told to, and goes quiet to play a half-open socket. */

const TIMING = { intervalMs: 5, deadlineMs: 20 }
const DROP = "drop"

interface Stub {
  readonly url: string
  readonly pings: string[]
  answer: boolean
  stop(): void
}

function startStub(): Stub {
  const pings: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      return srv.upgrade(request) ? undefined : new Response("websocket only", { status: 426 })
    },
    websocket: {
      message(ws, message) {
        if (typeof message !== "string") return
        // Ends the connection with no close frame, as an edge that drops a
        // socket does: the client sees 1006 and the server's peer, the
        // relay, may never hear of it.
        if (message === DROP) return ws.terminate()
        pings.push(message)
        if (stub.answer) ws.send(RELAY_PONG)
      },
    },
  })
  // The handler reads `stub.answer` only once a socket has opened, after this returns.
  const stub: Stub = {
    url: `ws://127.0.0.1:${server.port}`,
    pings,
    answer: true,
    stop() {
      server.stop(true)
    },
  }
  return stub
}

function opened(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener("open", () => resolve(ws), { once: true })
    ws.addEventListener("error", () => reject(new Error("failed to open")), { once: true })
  })
}

/** A relay socket whose link went half-open: it takes every send and every
 *  close and delivers nothing, so no close event ever arrives. */
class HalfOpenSocket extends EventTarget {
  readyState: WebSocket["readyState"] = WebSocket.OPEN
  binaryType: BinaryType = "arraybuffer"
  bufferedAmount = 0
  readonly sent: unknown[] = []
  readonly closes: { code: number | undefined; reason: string | undefined }[] = []
  send(data: unknown): void { this.sent.push(data) }
  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
    this.readyState = WebSocket.CLOSING
  }
  answer(): void { this.dispatchEvent(new MessageEvent("message", { data: RELAY_PONG })) }
  /** A sealed frame from the far end: the lane has carried data. */
  deliver(): void { this.dispatchEvent(new MessageEvent("message", { data: new ArrayBuffer(8) })) }
}

/** A timer that fires only when the test says so, however long after its
 *  interval, the way a stalled event loop or a hidden browser tab fires one. */
class LateTimer {
  private readonly scheduled = new Set<() => void>()
  readonly clock: HeartbeatClock = {
    every: (_intervalMs, fire) => {
      this.scheduled.add(fire)
      return () => { this.scheduled.delete(fire) }
    },
  }

  tick(): void {
    for (const fire of this.scheduled) fire()
  }
}

function closed(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => ws.addEventListener("close", () => resolve(), { once: true }))
}

describe("keepAlive", () => {
  const stubs: Stub[] = []
  afterEach(() => {
    for (const stub of stubs.splice(0)) stub.stop()
  })

  test("pings on the interval and stays up while the relay answers", async () => {
    const stub = startStub()
    stubs.push(stub)
    const ws = await opened(stub.url)
    const heartbeat = manualHeartbeatClock()
    let settled = false
    void keepAlive(ws, { ...TIMING, clock: heartbeat.clock }).then(() => { settled = true })
    for (let index = 0; index < 6; index += 1) {
      const answered = new Promise<void>((resolve) => ws.addEventListener("message", () => resolve(), { once: true }))
      heartbeat.advance(TIMING.intervalMs)
      await answered
    }
    expect(settled).toBe(false)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    expect(stub.pings.length).toBeGreaterThanOrEqual(2)
    expect(new Set(stub.pings)).toEqual(new Set([RELAY_PING]))
    ws.close(1000)
    await closed(ws)
  })

  test("settles and closes the socket when its first ping goes unanswered for the deadline", async () => {
    const stub = startStub()
    stubs.push(stub)
    stub.answer = false
    const ws = await opened(stub.url)
    const heartbeat = manualHeartbeatClock()
    const ended = keepAlive(ws, { ...TIMING, clock: heartbeat.clock })
    // The first ping goes out at once, so a socket that died before it was
    // handed over is caught one deadline in.
    heartbeat.advance(TIMING.deadlineMs - 1)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    heartbeat.advance(1)
    await ended
    expect(heartbeat.now()).toBe(TIMING.deadlineMs)
    expect(ws.readyState).not.toBe(WebSocket.OPEN)
  })

  test("settles when the socket closes", async () => {
    const stub = startStub()
    stubs.push(stub)
    const ws = await opened(stub.url)
    const pings: unknown[] = []
    const send = ws.send.bind(ws)
    ws.send = (data) => {
      pings.push(data)
      send(data)
    }
    const clock = manualHeartbeatClock()
    const heartbeat = keepAlive(ws, { ...TIMING, clock: clock.clock })
    ws.close(1000)
    await heartbeat
    const pinged = pings.length
    clock.advance(TIMING.deadlineMs)
    expect(pings).toHaveLength(pinged)
  })
})

describe("relayChannelStreams", () => {
  const stubs: Stub[] = []
  afterEach(() => {
    for (const stub of stubs.splice(0)) stub.stop()
  })

  test("ends the lane when a ping goes unanswered for the deadline, though the half-open socket never reports a close", async () => {
    // A relay link that died without a close delivers nothing more. The lane
    // must end on the heartbeat alone, or its reader waits on silence until
    // the runtime protocol's own deadline a minute later.
    const ws = new HalfOpenSocket()
    const heartbeat = manualHeartbeatClock()
    const streams = relayChannelStreams(ws, { ...TIMING, clock: heartbeat.clock })
    const reading = Effect.runPromiseExit(Effect.flatMap(
      Socket.fromTransformStream(Effect.succeed(streams)),
      (socket) => socket.run(() => {}),
    ))
    ws.deliver()
    heartbeat.advance(TIMING.intervalMs)
    expect(ws.sent).toEqual([RELAY_PING, RELAY_PING])
    ws.answer()
    heartbeat.advance(TIMING.intervalMs + TIMING.deadlineMs - 1)
    expect(ws.closes).toEqual([])
    heartbeat.advance(1)
    expect(await streams.closed).toEqual({ code: 4000, reason: "heartbeat timeout", abrupt: true })
    expect(ws.closes).toEqual([{ code: 4000, reason: "heartbeat timeout" }])
    const exit = await reading
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ reason: { _tag: "SocketCloseError", code: 4000 } })
    const pings = ws.sent.length
    heartbeat.advance(TIMING.deadlineMs * 2)
    expect(ws.sent).toHaveLength(pings)
  })

  test("counts a late tick as one interval, so a stalled or suspended timer never reads as silence", async () => {
    // A stalled event loop, a waking laptop, or a hidden browser tab runs the
    // heartbeat timer late. Silence measured on the wall clock would end a
    // healthy lane; only pings the relay left unanswered across the deadline's
    // worth of ticks are evidence.
    const ws = new HalfOpenSocket()
    const timer = new LateTimer()
    const streams = relayChannelStreams(ws, { ...TIMING, clock: timer.clock })
    let ended = false
    void streams.closed.then(() => { ended = true })
    ws.deliver()
    timer.tick()
    ws.answer()
    // Two ticks, each long past its interval: the first finds the ping
    // answered and pings again, the second counts one miss.
    timer.tick()
    timer.tick()
    await Promise.resolve()
    expect(ended).toBe(false)
    expect(ws.closes).toEqual([])
    expect(ws.sent).toEqual([RELAY_PING, RELAY_PING, RELAY_PING, RELAY_PING])
    // The deadline allows one miss per interval it spans.
    const missesAllowed = TIMING.deadlineMs / TIMING.intervalMs
    for (let missed = 1; missed < missesAllowed - 1; missed += 1) timer.tick()
    await Promise.resolve()
    expect(ended).toBe(false)
    timer.tick()
    expect(await streams.closed).toEqual({ code: 4000, reason: "heartbeat timeout", abrupt: true })
  })

  test("a lane that has carried nothing ends one interval after its first ping, which goes out at once", async () => {
    // Before the relay attaches a device, nothing but the relay's own talk
    // crosses the socket, so nothing queued can hold an answer back. A socket
    // that died as it opened must not cost the device a full deadline.
    const ws = new HalfOpenSocket()
    const heartbeat = manualHeartbeatClock()
    const streams = relayChannelStreams(ws, { ...TIMING, clock: heartbeat.clock })
    expect(ws.sent).toEqual([RELAY_PING])
    heartbeat.advance(TIMING.intervalMs - 1)
    expect(ws.closes).toEqual([])
    heartbeat.advance(1)
    expect(await streams.closed).toEqual({ code: 4000, reason: "heartbeat timeout", abrupt: true })
  })

  test("a lane passing its backlog to the network is busy, not silent, though its pings wait behind the backlog", async () => {
    // A ping is a message on the same socket as the data, so it leaves only
    // after every byte queued ahead of it. A large body on a slow uplink keeps
    // pings unanswered for as long as it takes to send; a backlog that keeps
    // shrinking proves the link works.
    const ws = new HalfOpenSocket()
    const heartbeat = manualHeartbeatClock()
    const streams = relayChannelStreams(ws, { ...TIMING, clock: heartbeat.clock })
    let ended = false
    void streams.closed.then(() => { ended = true })
    ws.deliver()
    await streams.writable.getWriter().write(new Uint8Array(4096))
    ws.bufferedAmount = 4096
    const missesAllowed = TIMING.deadlineMs / TIMING.intervalMs
    for (let tick = 0; tick < missesAllowed * 3; tick += 1) {
      ws.bufferedAmount -= 100
      heartbeat.advance(TIMING.intervalMs)
    }
    await Promise.resolve()
    expect(ended).toBe(false)
    expect(ws.closes).toEqual([])
    // A backlog that stops shrinking is a link that stopped moving bytes.
    heartbeat.advance(TIMING.deadlineMs)
    expect(await streams.closed).toEqual({ code: 4000, reason: "heartbeat timeout", abrupt: true })
  })

  test("a lane that hands bytes to a socket with room is not proven alive by them", async () => {
    // The kernel takes small writes on a dead link until its own buffer
    // fills, so bytes leaving a socket that held no backlog prove nothing: a
    // runtime's event heartbeats must not keep a dead lane open.
    const ws = new HalfOpenSocket()
    const heartbeat = manualHeartbeatClock()
    const streams = relayChannelStreams(ws, { ...TIMING, clock: heartbeat.clock })
    ws.deliver()
    const writer = streams.writable.getWriter()
    // The first tick finds the ping answered by the delivered frame; each one
    // after it counts a miss.
    const missesAllowed = TIMING.deadlineMs / TIMING.intervalMs
    for (let tick = 0; tick <= missesAllowed; tick += 1) {
      await writer.write(new Uint8Array(64))
      heartbeat.advance(TIMING.intervalMs)
    }
    expect(await streams.closed).toEqual({ code: 4000, reason: "heartbeat timeout", abrupt: true })
  })

  test("marks a lane whose connection ended with no close handshake as abrupt", async () => {
    // The relay may never have seen such an end, so the machine reports it
    // on its control socket; a close the two sides exchanged needs no report.
    const stub = startStub()
    stubs.push(stub)
    const ws = await opened(stub.url)
    const streams = relayChannelStreams(ws)
    ws.send(DROP)
    expect(await streams.closed).toMatchObject({ code: 1006, abrupt: true })
  })

  test("settles `closed` with the code and reason the socket closed with", async () => {
    // A runtime logs this close to tell a phone that hung up from a phone the
    // relay swept; the code and reason must survive the wrap.
    const stub = startStub()
    stubs.push(stub)
    const ws = await opened(stub.url)
    const streams = relayChannelStreams(ws)
    const reading = Effect.runPromiseExit(Effect.flatMap(
      Socket.fromTransformStream(Effect.succeed(streams)),
      (socket) => socket.run(() => {}),
    ))
    ws.close(4321, "bye")
    expect(await streams.closed).toEqual({ code: 4321, reason: "bye", abrupt: false })
    const exit = await reading
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toMatchObject({
        reason: { _tag: "SocketCloseError", code: 4321, closeReason: "bye" },
      })
    }
  })
})

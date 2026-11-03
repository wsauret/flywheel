import { Socket } from "effect/socket"
import { decodeJsonFrame, decodeRelayDeviceFrame, deviceAttachSigningBytes, ownedBytes, RELAY_HEARTBEAT_INTERVAL_MS, RELAY_MISSED_HEARTBEATS, RELAY_PING, toBase64Url, type DeviceFrame, type Placement, type RelayRejectReason } from "./relay-protocol.js"

/** A WebSocket as the two web streams `Socket.fromTransformStream` consumes,
 *  the heartbeat that ends a relay socket whose link died, and the device-side
 *  handshake that turns a relay socket into a channel.
 *
 *  Both ends of a relay channel use this: the runtime for the channel it dials
 *  when the relay says `open`, the phone for the device socket it attaches
 *  with. Effect ships `Socket.makeWebSocket`, but its writer hands every frame
 *  to `send` and returns, which is wrong for the runtime: it publishes a live
 *  transcript onto this lane, and a phone that stops reading must slow the
 *  publisher down, as the unix socket does through the kernel buffer. The
 *  WebSocket API has no drain event, so the writer watches `bufferedAmount`
 *  and parks until the socket has taken what it was given. A socket that will
 *  not drain within the window is closed, so a wedged peer costs one channel
 *  and never memory.
 *
 *  DOM WebSocket API only, so the same module runs in Bun and in a browser. */

/** Bytes the socket may hold unsent before the writer parks. One large frame
 *  always goes through; the bound is on how far ahead the writer may run. */
const WRITE_HIGH_WATER_BYTES = 1024 * 1024
const DRAIN_POLL_MS = 20
const DRAIN_TIMEOUT_MS = 30_000

/** How a channel socket ended: the close code and reason the other side sent,
 *  or the ones this side chose. The relay passes the far peer's own code and
 *  reason through in the reason text, so a runtime reading this learns
 *  whether the phone hung up, the relay swept the phone, or its own close
 *  landed. */
interface RelayChannelClose {
  readonly code: number
  readonly reason: string
  /** The socket ended with no close handshake: the connection dropped
   *  (1006), or the heartbeat gave up on a link that answers nothing. The
   *  relay may never hear such an end, so the machine reports it
   *  (`channel.ended`); a close the two sides exchanged needs no report. */
  readonly abrupt: boolean
}

/** The close code a WebSocket reports when the connection ended without a
 *  close frame. */
const NO_CLOSE_FRAME_CODE = 1006

export interface RelayChannelStreams {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
  /** Settles when the socket closes, however it closes, with the close it saw. */
  readonly closed: Promise<RelayChannelClose>
}

/** The socket operations shared by relay control and binary channels. The
 *  heartbeat reads `bufferedAmount` to tell a socket busy sending from a
 *  silent one. */
export type RelaySocket = Pick<WebSocket, "readyState" | "send" | "close" | "addEventListener" | "removeEventListener" | "bufferedAmount">

/** The binary lane also controls frame representation. */
export type RelayChannelSocket = RelaySocket & Pick<WebSocket, "binaryType">

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Wraps an open WebSocket as the binary lane of a relay channel, and keeps
 *  its heartbeat for as long as it lives.
 *
 *  Install it as soon as the socket opens, before the relay's text handshake
 *  runs on the same socket: the far end's first sealed frame can arrive in the
 *  same turn as the relay's `attached`, and a listener added later misses it.
 *  The readable buffers until the sealed socket starts reading. Text frames
 *  are the relay's own talk and never reach the sealed layer; whoever runs the
 *  handshake reads them with a listener of its own.
 *
 *  The lane ends when the socket closes, or when a ping goes unanswered for
 *  the heartbeat's deadline. A link that died without a close delivers no
 *  close event, often for minutes, so the heartbeat ends the lane itself, with
 *  close code 4000, rather than waiting on the socket to report it. The lane
 *  tells its heartbeat what it sends and whether it has carried data yet, so
 *  a lane busy sending is never taken for a silent one and a lane that has
 *  carried nothing is judged in one interval (`LaneTraffic`). */
export function relayChannelStreams(ws: RelayChannelSocket, timing: HeartbeatTiming = RELAY_HEARTBEAT): RelayChannelStreams {
  let readController: ReadableStreamDefaultController<Uint8Array> | undefined
  let closed = false
  let handedBytes = 0
  let carried = false
  const ended = Promise.withResolvers<RelayChannelClose>()
  const end = (close: RelayChannelClose) => {
    if (closed) return
    closed = true
    stopHeartbeat()
    try {
      if (close.code === 1000) readController?.close()
      else readController?.error(new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: close.code, closeReason: close.reason }) }))
    } catch {
      // The reader already ended on its own.
    }
    ended.resolve(close)
  }
  ws.addEventListener("close", (event: CloseEvent) => end({ code: event.code, reason: event.reason, abrupt: event.code === NO_CLOSE_FRAME_CODE }), { once: true })
  const stopHeartbeat = heartbeat(ws, () => {
    ws.close(HEARTBEAT_CLOSE_CODE, HEARTBEAT_CLOSE_REASON)
    end({ code: HEARTBEAT_CLOSE_CODE, reason: HEARTBEAT_CLOSE_REASON, abrupt: true })
  }, timing, { handedBytes: () => handedBytes, carried: () => carried })
  ws.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data
    if (data instanceof ArrayBuffer) {
      carried = true
      readController?.enqueue(new Uint8Array(data))
    } else if (data instanceof Uint8Array) {
      carried = true
      readController?.enqueue(data)
    }
  })

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readController = controller
    },
    cancel() {
      ws.close(1000)
    },
  })

  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      if (closed) throw new Error("relay channel closed during write")
      const bytes = ownedBytes(chunk)
      ws.send(bytes)
      handedBytes += bytes.byteLength
      carried = true
      if (ws.bufferedAmount <= WRITE_HIGH_WATER_BYTES) return
      const deadline = Date.now() + DRAIN_TIMEOUT_MS
      while (ws.bufferedAmount > WRITE_HIGH_WATER_BYTES) {
        if (closed) throw new Error("relay channel closed during write")
        if (Date.now() > deadline) {
          ws.close(1013, "peer is not draining")
          throw new Error("relay channel did not drain within the window")
        }
        await sleep(DRAIN_POLL_MS)
      }
    },
    close() {
      ws.close(1000)
    },
    abort() {
      ws.close(1011)
    },
  })

  return { readable, writable, closed: ended.promise }
}

/** Settles once a dialed WebSocket is open, or fails with the close or error
 *  that arrived first. */
function openWebSocket(ws: WebSocket, openTimeoutMs: number): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close(1000)
      reject(new Error("relay did not accept the connection in time"))
    }, openTimeoutMs)
    const settle = (outcome: () => void) => () => {
      clearTimeout(timer)
      outcome()
    }
    ws.addEventListener("open", settle(() => resolve(ws)), { once: true })
    ws.addEventListener("error", settle(() => reject(new Error("relay connection failed"))), { once: true })
    ws.addEventListener("close", settle(() => reject(new Error("relay closed the connection before it opened"))), { once: true })
  })
}

/** What a socket's own sending tells its heartbeat. A ping is a message on
 *  the same socket as everything else this end sends, so it leaves only
 *  after every byte queued ahead of it, and a large body on a slow link holds
 *  its answer back for as long as the body takes. A socket that held a
 *  backlog at the last tick and holds less of it now, counting what it was
 *  handed since, moved bytes onto the network: the link works and the
 *  missing answer proves nothing. Bytes that leave a socket holding no
 *  backlog prove nothing either way, because the kernel takes small writes
 *  on a dead link until its own buffer fills. */
export interface LaneTraffic {
  /** Every byte this end has handed the socket so far, its pings aside. */
  readonly handedBytes: () => number
  /** Whether the socket has carried data yet, in either direction. Until it
   *  has, nothing queued can hold an answer back, so one unanswered interval
   *  ends it. Absent, the socket is judged as one carrying data. */
  readonly carried?: () => boolean
}

export interface HeartbeatTiming {
  readonly intervalMs: number
  /** How long pings may go unanswered, counted in intervals of the heartbeat. */
  readonly deadlineMs: number
  readonly clock?: HeartbeatClock
}

/** The heartbeat's timer. It counts ticks, not elapsed time, so the timer
 *  is all it needs: `every` schedules future callbacks and returns their
 *  cancellation. */
export interface HeartbeatClock {
  readonly every: (intervalMs: number, callback: () => void) => () => void
}

const systemHeartbeatClock: HeartbeatClock = {
  every(intervalMs, callback) {
    const timer = setInterval(callback, intervalMs)
    return () => clearInterval(timer)
  },
}

/** The contract's timing. Tests can control the clock without wall-clock waits. */
export const RELAY_HEARTBEAT: HeartbeatTiming = { intervalMs: RELAY_HEARTBEAT_INTERVAL_MS, deadlineMs: RELAY_HEARTBEAT_INTERVAL_MS * RELAY_MISSED_HEARTBEATS }

/** A client-chosen close code, outside the range the protocol reserves. */
export const HEARTBEAT_CLOSE_CODE = 4000
export const HEARTBEAT_CLOSE_REASON = "heartbeat timeout"

/** Pings the relay at once and then every interval, and calls `onSilent`
 *  once, with the heartbeat stopped, when pings have gone unanswered for the
 *  deadline. Any frame the relay sends answers every ping before it. The
 *  deadline is counted in ticks of the heartbeat, as the executor's is
 *  (ARCH-RUNTIME-020): each tick that finds a ping still unanswered counts one
 *  interval however late it fires, so a stalled event loop, a waking laptop,
 *  or a hidden browser tab whose timers run late never reads as silence. A
 *  tick at which the socket's own sending shows the link moving bytes counts
 *  nothing (`LaneTraffic`). A half-open socket never delivers its close
 *  event, so the caller ends what the socket carried itself. Returns the
 *  stop, which the caller runs when the socket closes. */
export function heartbeat(ws: RelaySocket, onSilent: () => void, timing: HeartbeatTiming = RELAY_HEARTBEAT, traffic?: LaneTraffic): () => void {
  const clock = timing.clock ?? systemHeartbeatClock
  const allowedMisses = Math.ceil(timing.deadlineMs / timing.intervalMs)
  let awaitingAnswer = false
  let missed = 0
  // Sampled before each tick's ping, so the ping's own bytes never read as
  // the lane's data moving.
  let backlog = ws.bufferedAmount
  let handed = traffic?.handedBytes() ?? 0
  const heard = () => {
    awaitingAnswer = false
    missed = 0
  }
  const ping = () => {
    if (ws.readyState !== WebSocket.OPEN) return
    awaitingAnswer = true
    ws.send(RELAY_PING)
  }
  const stopTicks = clock.every(timing.intervalMs, () => {
    const nowBacklog = ws.bufferedAmount
    const nowHanded = traffic?.handedBytes() ?? 0
    const moving = traffic !== undefined && backlog > 0 && nowBacklog < backlog + (nowHanded - handed)
    backlog = nowBacklog
    handed = nowHanded
    if (awaitingAnswer && !moving) missed += 1
    if (missed >= (traffic?.carried?.() === false ? 1 : allowedMisses)) {
      stop()
      onSilent()
      return
    }
    ping()
  })
  const stop = () => {
    stopTicks()
    ws.removeEventListener("message", heard)
  }
  ws.addEventListener("message", heard)
  ping()
  return stop
}

/** A heartbeat for a socket whose caller only needs to know when it ends:
 *  settles when the socket closes, or when a ping goes unanswered for the
 *  deadline, after asking the socket to close. The caller treats a settled
 *  heartbeat as a closed socket and dials again. */
export function keepAlive(ws: RelaySocket, timing: HeartbeatTiming = RELAY_HEARTBEAT): Promise<void> {
  const settled = Promise.withResolvers<void>()
  const settle = () => {
    stop()
    ws.removeEventListener("close", settle)
    settled.resolve()
  }
  const stop = heartbeat(ws, () => {
    ws.close(HEARTBEAT_CLOSE_CODE, HEARTBEAT_CLOSE_REASON)
    settle()
  }, timing)
  ws.addEventListener("close", settle, { once: true })
  return settled.promise
}

/** The relay said no. The reason is the relay's word, carried as data. */
/** The relay refused a device socket, or closed it before admitting it. */
export class RelayRefusal extends Error {
  readonly _tag = "RelayRefusal" as const
  constructor(readonly reason: RelayRejectReason | "closed") {
    super(reason === "daily_budget" ? "This machine used the relay's daily data allowance. Remote access works again after midnight UTC." : `the relay refused: ${reason}`)
  }
}

/** A device's identity as the relay sees it: the key the runtime recorded at
 *  pairing, and a signer for the challenge. */
export interface DeviceIdentity {
  readonly publicKey: Uint8Array
  readonly deviceId: string
  readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>
}

export interface DeviceChannel {
  readonly ws: WebSocket
  readonly streams: RelayChannelStreams
}

const DEVICE_OPEN_TIMEOUT_MS = 15_000

/** Opens a device socket to the relay and answers its challenge with `answer`.
 *  Resolves once the relay says `attached`, with the binary lane already
 *  installed; rejects with the relay's reason otherwise. If `waitForStarted`
 *  is supplied, a starting response keeps this socket open for a later
 *  refusal until that callback settles. Its signal cancels the wait when this
 *  socket attaches. A resolved callback rejects with `runtime_starting` so the
 *  caller can attach to the now-live runtime. */
async function openDeviceChannel(relayUrl: string, runtimeId: string, answer: (nonce: string) => Promise<DeviceFrame>, waitForStarted?: (signal: AbortSignal) => Promise<void>): Promise<DeviceChannel> {
  const ws = await openWebSocket(new WebSocket(`${relayUrl}/device/${runtimeId}`), DEVICE_OPEN_TIMEOUT_MS)
  ws.binaryType = "arraybuffer"
  const streams = relayChannelStreams(ws)
  const attached = Promise.withResolvers<DeviceChannel>()
  const wake = new AbortController()
  ws.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return
    void (async () => {
      const frame = decodeJsonFrame(decodeRelayDeviceFrame, event.data)
      if (frame.type === "challenge") ws.send(JSON.stringify(await answer(frame.nonce)))
      else if (frame.type === "attached") {
        wake.abort()
        attached.resolve({ ws, streams })
      }
      else if (frame.type === "rejected") {
        if (frame.reason === "runtime_starting" && waitForStarted !== undefined) {
          try {
            await waitForStarted(wake.signal)
          } catch (cause) {
            if (!wake.signal.aborted) attached.reject(cause)
          }
          if (wake.signal.aborted) return
          ws.close(1000)
        }
        attached.reject(new RelayRefusal(frame.reason))
      }
    })().catch((cause: unknown) => {
      ws.close(1002, "protocol error")
      attached.reject(cause instanceof Error ? cause : new Error(String(cause)))
    })
  })
  // The lane ending, by a close or by a heartbeat the relay stopped
  // answering, ends a handshake still waiting on it.
  void streams.closed.then(({ code, reason }) => {
    // Relays deployed before wake sockets stayed open close after starting.
    // Presence still settles that wake through the callback.
    if (waitForStarted !== undefined && code === 1008 && reason === "runtime_starting") return
    attached.reject(new RelayRefusal("closed"))
  })
  return attached.promise
}

/** Attaches a paired device to one placement. `waitForStarted` retains the
 *  wake socket until presence reports live or this socket attaches, so a
 *  startup refusal can arrive. Attachment aborts the callback's signal. */
export function attachDeviceChannel(relayUrl: string, runtimeId: string, placementId: string, device: DeviceIdentity, waitForStarted?: (signal: AbortSignal) => Promise<void>): Promise<DeviceChannel> {
  return openDeviceChannel(relayUrl, runtimeId, async (nonce) => ({
    type: "attach",
    runtimeId,
    deviceId: device.deviceId,
    publicKey: toBase64Url(device.publicKey),
    placementId,
    signature: toBase64Url(await device.sign(deviceAttachSigningBytes({ nonce, runtimeId, deviceId: device.deviceId }))),
  }), waitForStarted)
}

/** Opens the one pairing channel a window admits. */
export function openPairingChannel(relayUrl: string, runtimeId: string, windowId: string): Promise<DeviceChannel> {
  return openDeviceChannel(relayUrl, runtimeId, async () => ({ type: "pair", runtimeId, windowId }))
}

export interface PresenceWatch {
  close(): void
}

/** Watches which placements of a runtime are online. `onPlacements` fires with
 *  the current list on attach and on every change; `onEnd` fires when the
 *  socket closes or the relay refuses, and the caller decides about retrying. */
export function watchPresence(relayUrl: string, runtimeId: string, device: DeviceIdentity, onPlacements: (placements: readonly Placement[]) => void, onEnd: (reason: RelayRejectReason | "closed" | "error") => void): PresenceWatch {
  let ws: WebSocket | undefined
  let ended = false
  const end = (reason: RelayRejectReason | "closed" | "error") => {
    if (ended) return
    ended = true
    onEnd(reason)
  }
  void (async () => {
    const socket = await openWebSocket(new WebSocket(`${relayUrl}/device/${runtimeId}`), DEVICE_OPEN_TIMEOUT_MS).catch(() => undefined)
    if (!socket) return end("error")
    ws = socket
    if (ended) {
      socket.close(1000)
      return
    }
    socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") return
      void (async () => {
        const frame = decodeJsonFrame(decodeRelayDeviceFrame, event.data)
        if (frame.type === "challenge") {
          socket.send(JSON.stringify({ type: "presence", runtimeId, deviceId: device.deviceId, publicKey: toBase64Url(device.publicKey), signature: toBase64Url(await device.sign(deviceAttachSigningBytes({ nonce: frame.nonce, runtimeId, deviceId: device.deviceId }))) } satisfies DeviceFrame))
        } else if (frame.type === "presence") onPlacements(frame.placements)
        else if (frame.type === "rejected") end(frame.reason)
      })().catch(() => {
        socket.close(1002, "protocol error")
        end("error")
      })
    })
    await keepAlive(socket)
    end("closed")
  })()
  return {
    close() {
      ended = true
      ws?.close(1000)
    },
  }
}

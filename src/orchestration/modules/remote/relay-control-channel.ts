import { Deferred, Effect, Result } from "effect"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { errorMessage } from "../../../infra/error-message.js"
import { Log } from "../../../infra/log.js"
import { coalesceRepeats } from "../../../infra/repeat-coalescer.js"
import { MAX_RECONNECT_ATTEMPT, reconnectBackoffMs } from "../../../protocol/client/connection.js"
import { HEARTBEAT_CLOSE_CODE, HEARTBEAT_CLOSE_REASON, heartbeat, RELAY_HEARTBEAT, type HeartbeatTiming, type RelaySocket } from "../../../protocol/modules/remote/relay-channel.js"
import {
  ASSET_CHUNK_BYTES,
  decodeJsonFrame,
  encodeAssetChunk,
  decodeRelayControlFrame,
  RELAY_PROTOCOL_VERSION,
  runtimeAttachSigningBytes,
  toBase64Url,
  withStatedHeartbeat,
  type AssetRequestFrame,
  type OpenFrame,
  type Placement,
  type RelayRejectReason,
  type RuntimeControlFrame,
} from "../../../protocol/modules/remote/relay-protocol.js"
import type { RemoteConnectionState } from "../../../protocol/modules/remote.js"
import { bridgeExternalPromise } from "../../agent-runtime/external-promise-bridge.js"
import type { SettledControlUiAssetState } from "../../app-service/web-serving/control-ui-assets.js"
import { controlUiContentType } from "../../app-service/web-serving/control-ui-static.js"
import type { RemoteIdentity } from "./remote-identity.js"

/** One outbound control channel to the relay, announcing one placement.
 *
 *  The loop dials the relay while a connection is wanted, answers the
 *  challenge with a signed attach, holds the socket with the contract's
 *  heartbeat, reconnects on the client's backoff when it drops, asks again
 *  every few minutes while the relay refuses its protocol version, and parks
 *  until told otherwise after a refusal only the owner can change. Every `open` the
 *  relay sends goes to the owner, which either dials the channel (a runtime
 *  placement) or declines it (the account service announcing an asleep one). Two
 *  owners share this so the relay sees one behavior from both.
 *
 *  It also tells the relay when a data channel it opened ended where the relay
 *  may not have seen it (`channelOpened`), so the relay closes the device's
 *  side at once instead of when the channel's heartbeat goes silent.
 *
 *  The channel also carries the web client this process serves. The placement
 *  it announces names the client's identity, and the relay, which serves and
 *  caches that client for phones, asks for its files over this socket; the
 *  channel answers only for its own identity and only from the phone shell's
 *  directory of the build, in binary chunk frames. */

const log = Log.create({ service: "relay-control-channel" })

const OPEN_TIMEOUT_MS = 15_000

/** Refusals that no retry can change until the owner changes what it sends:
 *  the identity itself is refused, or the relay could not read the attach.
 *  Retrying would only make a log line per backoff. */
const PARKING_REJECTIONS: ReadonlySet<RelayRejectReason> = new Set(["bad_signature", "malformed"])

/** The longest wait between dials while the relay refuses this build's
 *  protocol version. Either side heals that refusal, a relay deploy or a newer
 *  build, and neither arrives within seconds, so the channel asks every few
 *  minutes instead of on the reconnect backoff. */
const MISMATCH_RETRY_MS = 5 * 60_000

/** How long one episode of interruptions collects repeats. A channel that
 *  drops every half hour writes one record for the first drop and one count
 *  an hour after, not a pair of records per drop. */
const INTERRUPTION_WINDOW_MS = 60 * 60_000

/** One control session that ended while a connection was still wanted. */
interface ChannelInterruption {
  /** The close code and reason, or the error that ended the attempt. */
  readonly cause: string
  readonly outcome: ControlFailureOutcome
  /** How long the relay had admitted the placement, when it had. */
  readonly attachedMs?: number
  /** The wait before the next dial; absent while parked until the owner asks. */
  readonly nextDialMs?: number
}

/** What a refusal means to the person, since the reason word alone sent
 *  a reader looking for a corrupt frame when the build was simply old. */
function refusalMessage(reason: RelayRejectReason): string {
  switch (reason) {
    case "protocol_version":
      return `the relay does not admit relay protocol ${RELAY_PROTOCOL_VERSION}, which this Flywheel speaks; update Flywheel with \`flywheel update\`, or deploy the newest relay if you host it yourself. Flywheel asks again every few minutes`
    case "bad_signature":
      return "the relay did not accept this machine's identity"
    case "malformed":
      return "the relay could not read what this Flywheel sent"
    case "admission_closed":
      return "the relay is not admitting machines right now. Flywheel keeps trying"
    default:
      return `the relay refused this runtime: ${reason}`
  }
}

class RelayRefusedError extends Error {
  readonly _tag = "RelayRefusedError" as const
  constructor(readonly reason: RelayRejectReason) {
    super(refusalMessage(reason))
  }
}

/** How a failed control session leaves the channel. `retry` backs off and
 *  dials again; `mismatched` dials again after minutes, because the relay and
 *  this build disagree about the protocol until one of them is updated;
 *  `parked` waits for the owner to change what would be sent (a pairing
 *  window, a store change). The owner asking again ends any wait early. */
type ControlFailureOutcome = "retry" | "mismatched" | "parked"

type ControlSend = (frame: RuntimeControlFrame) => void

/** The web client this process serves: the identity its build wrote and the
 *  build directory whose `phone/` holds what a phone loads. */
export interface ServedClient {
  readonly identity: string
  readonly root: string
}

/** The served client as the runtime's one client resolution states it:
 *  nothing while that resolution failed. */
export function servedClientOf(settle: () => Promise<SettledControlUiAssetState>): () => Promise<ServedClient | undefined> {
  return async () => {
    const client = await settle()
    return client.kind === "resolved" ? { identity: client.identity, root: client.root } : undefined
  }
}

export interface RelayControlChannelOptions {
  readonly relayUrl: () => string
  readonly identity: () => Promise<RemoteIdentity>
  /** Read at every attach, so a placement whose version or state changed
   *  announces the new word on its next connection. The channel adds the
   *  served client's identity itself, so the identity announced is always the
   *  one it serves. */
  readonly placement: () => Placement
  /** The web client this process serves, read at every attach. Absent, or
   *  resolving to nothing, where no client is served: the placement then
   *  names none and every asset request is refused. */
  readonly client?: () => Promise<ServedClient | undefined>
  readonly devices: () => readonly string[]
  /** Whether a connection is wanted right now. Read after every session and
   *  on every `reconcile()`. */
  readonly wanted: () => boolean
  readonly connect: (url: string) => RelaySocket
  /** The contract's timing unless a test needs a faster one. The data
   *  channels this placement dials keep the same timing, so its deadline is
   *  also how long the relay may hold a channel whose end it never heard. */
  readonly heartbeat?: HeartbeatTiming
  readonly random?: () => number
  readonly now?: () => number
  readonly onConnection: (state: RemoteConnectionState) => void
  /** The relay admitted the placement; `send` reaches it until the socket closes. */
  readonly onAttached?: (send: ControlSend) => void
  /** Transfers data-channel work to the placement owner before resolving.
   *  Established channels outlive this control connection and must not be awaited here. */
  readonly onOpen: (frame: OpenFrame, send: ControlSend) => Promise<void>
  /** A control session ended with an error, and this is what the channel does
   *  next. */
  readonly onFailure: (error: string, outcome: ControlFailureOutcome) => void
}

export interface RelayControlChannel {
  /** Sends on the attached control socket. False when none is attached. */
  send(frame: RuntimeControlFrame): boolean
  /** Counts one dial of the data channel `channelId` from the moment its
   *  socket opens, and returns what the dial calls when that socket ends.
   *
   *  A dial that ended with no close handshake tells the relay
   *  (`channel.ended`), so the relay closes the device's side now. The relay
   *  can send one channel's `open` to two control sockets, so two dials of
   *  one id can be open together, and the first to present the ticket gets
   *  the channel; a dial therefore reports only when no other dial of its id
   *  is still open, so a losing dial never closes the winner's device. The
   *  same drop often ends the control socket too, or ends it a moment later
   *  and loses the report, so every attach repeats the report until the
   *  relay would have closed the channel on its own, or until a new dial of
   *  the id opens, which makes the report stale. */
  channelOpened(channelId: string): (close: { readonly abrupt: boolean }) => void
  connected(): boolean
  /** Re-reads `wanted`: starts or wakes the loop when a connection is wanted,
   *  and closes the socket with `closeReason` when it is not. */
  reconcile(closeReason: string): void
  /** Interrupts acquisition and connected work, releases the socket, and joins the loop. */
  dispose(reason: string): Promise<void>
}

export function createRelayControlChannel(options: RelayControlChannelOptions): RelayControlChannel {
  const random = options.random ?? Math.random
  const now = options.now ?? Date.now
  const channelDeadlineMs = (options.heartbeat ?? RELAY_HEARTBEAT).deadlineMs
  // The data channels that ended with no close handshake, by id, with when.
  // After the channel deadline the relay has closed each one itself.
  const endedChannels = new Map<string, number>()
  // How many dials of each channel id have an open socket.
  const openDials = new Map<string, number>()
  let control: ControlSend | undefined
  let loop: { stop: (code: number, reason: string) => void; done: Promise<void> } | undefined
  let wake: (() => void) | undefined
  let disposed = false
  // What the diagnostics say about this placement's channel: its id, when the
  // relay last admitted it, whether it ever did, and how its last socket closed.
  let placementId: string | undefined
  let attachedAt: number | undefined
  let attachedBefore = false
  let lastClose: string | undefined
  // The relay the running session dialed, until that session ends. The
  // owner's relay can change under it (a pairing to another relay), and only
  // a new dial reaches the new one.
  let dialedRelayUrl: string | undefined

  const wanted = () => !disposed && options.wanted()

  // The first interruption of an episode records in full; later ones count by
  // cause and report once per window, with whether the channel is attached.
  const interruptions = coalesceRepeats<ChannelInterruption>({
    windowMs: INTERRUPTION_WINDOW_MS,
    first: (_condition, interruption) => {
      log.warn("relay control channel ended", { placement: placementId, ...interruption })
    },
    repeated: (_condition, repeats) => {
      const byCause: { [cause: string]: number } = {}
      for (const interruption of repeats.events) byCause[interruption.cause] = (byCause[interruption.cause] ?? 0) + 1
      log.warn("relay control channel ended again", { placement: placementId, count: repeats.count, windowMs: repeats.windowMs, byCause, attached: control !== undefined })
    },
  })

  /** Answers one asset request: the file of `served`'s phone shell in chunk
   *  frames, or a refusal for any other identity or a file it does not have.
   *  The file name is a bare name by the frame's schema, so it cannot leave
   *  the shell's directory. */
  async function answerAsset(sendHere: ControlSend, sendChunk: (bytes: Uint8Array<ArrayBuffer>) => void, frame: AssetRequestFrame, served: ServedClient | undefined): Promise<void> {
    const content = served?.identity === frame.identity ? await readFile(join(served.root, "phone", frame.file)).catch(() => undefined) : undefined
    if (content === undefined) {
      sendHere({ type: "asset.missing", requestId: frame.requestId })
      return
    }
    sendHere({ type: "asset.head", requestId: frame.requestId, contentType: controlUiContentType(frame.file) })
    for (let start = 0; start < content.byteLength; start += ASSET_CHUNK_BYTES) {
      sendChunk(encodeAssetChunk(frame.requestId, content.subarray(start, start + ASSET_CHUNK_BYTES)))
    }
    sendHere({ type: "asset.end", requestId: frame.requestId })
  }

  /** Forgets the ended channels the relay has closed by now. */
  function pruneEndedChannels(): void {
    for (const [channelId, endedAt] of endedChannels) if (now() - endedAt >= channelDeadlineMs) endedChannels.delete(channelId)
  }

  /** Parks the loop for `ms`, or until something it waits on changes. With no
   *  bound it parks until woken. */
  function park(ms: number | undefined): Effect.Effect<void> {
    return Effect.callback((resume) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const clear = () => {
        if (timer !== undefined) clearTimeout(timer)
        wake = undefined
      }
      wake = () => { clear(); resume(Effect.void) }
      if (ms !== undefined) timer = setTimeout(() => wake?.(), ms)
      return Effect.sync(clear)
    })
  }

  function ensureLoop(): void {
    wake?.()
    if (loop || !wanted()) return
    const owner = new AbortController()
    let close = { code: 1000, reason: "control session ended" }
    loop = {
      stop(code, reason) {
        close = { code, reason }
        control = undefined
        owner.abort()
      },
      done: Effect.runPromiseExit(runLoop(owner.signal, () => close), { signal: owner.signal }).then(() => {
        loop = undefined
        if (wanted()) ensureLoop()
        else options.onConnection("off")
      }),
    }
  }

  function runLoop(signal: AbortSignal, close: () => { code: number; reason: string }): Effect.Effect<void> {
    return Effect.gen(function*() {
      let attempt = 0
      while (wanted()) {
        options.onConnection(attempt === 0 ? "connecting" : "reconnecting")
        let outcome: ControlFailureOutcome = "retry"
        // Cleared here, not when a session ends: a relay change interrupts the
        // loop before that, and this attempt must not report its admission.
        lastClose = undefined
        attachedAt = undefined
        const result = yield* Effect.result(runSession(signal, close))
        const attachedMs = attachedAt === undefined ? undefined : Date.now() - attachedAt
        let cause = lastClose ?? "the relay closed the connection"
        if (Result.isFailure(result)) {
          const error = result.failure
          if (error instanceof RelayRefusedError && error.reason === "protocol_version") outcome = "mismatched"
          else if (error instanceof RelayRefusedError && PARKING_REJECTIONS.has(error.reason)) outcome = "parked"
          cause = errorMessage(error)
          options.onFailure(cause, outcome)
        } else if (result.success) {
          attempt = 0
        }
        if (!wanted()) return
        const nextDialMs = outcome === "retry"
          ? reconnectBackoffMs(attempt, random)
          : outcome === "mismatched" ? MISMATCH_RETRY_MS * (0.5 + random() * 0.5) : undefined
        interruptions.observe("interrupted", {
          cause, outcome,
          ...(attachedMs === undefined ? {} : { attachedMs }),
          ...(nextDialMs === undefined ? {} : { nextDialMs: Math.round(nextDialMs) }),
        })
        if (outcome !== "retry") {
          // A new pairing window or store change is the owner asking again.
          options.onConnection("off")
          yield* park(nextDialMs)
          attempt = 0
          continue
        }
        options.onConnection("reconnecting")
        yield* park(nextDialMs)
        attempt = Math.min(attempt + 1, MAX_RECONNECT_ATTEMPT)
      }
    })
  }

  /** The attempt scope owns acquisition, frame handlers, timers, and socket release. */
  function runSession(signal: AbortSignal, close: () => { code: number; reason: string }): Effect.Effect<boolean, unknown> {
    return Effect.scoped(Effect.gen(function*() {
      const identity = yield* Effect.tryPromise({ try: options.identity, catch: (error) => error })
      const served = options.client === undefined ? undefined : yield* Effect.tryPromise({ try: options.client, catch: (error) => error })
      const announced = yield* Effect.try({ try: options.placement, catch: (error) => error })
      placementId = announced.id
      const placement: Placement = served === undefined ? announced : { ...announced, clientIdentity: served.identity }
      // The socket states its heartbeat, so the relay drops it from presence
      // within that deadline once it falls silent, and a device dialing again
      // meanwhile is not told to a socket that died with the machine's link.
      const relayUrl = options.relayUrl()
      const ws = yield* Effect.acquireRelease(
        Effect.try({ try: () => options.connect(withStatedHeartbeat(`${relayUrl}/runtime/${identity.runtimeId}`, (options.heartbeat ?? RELAY_HEARTBEAT).intervalMs)), catch: (error) => error }),
        (socket) => Effect.sync(() => {
          dialedRelayUrl = undefined
          if (socket.readyState < WebSocket.CLOSING) socket.close(close().code, close().reason)
        }),
      )
      dialedRelayUrl = relayUrl
      const scope = yield* Effect.scope
      const ended = yield* Deferred.make<boolean, Error>()
      let live = true
      let opened = false
      let admitted = false
      let refused: RelayRejectReason | undefined
      let stopHeartbeat: (() => void) | undefined
      // What this socket was handed, which tells the heartbeat a socket busy
      // sending a client file from a silent one.
      let handedBytes = 0
      const finish = (result: Effect.Effect<boolean, Error>) => {
        live = false
        Deferred.doneUnsafe(ended, result)
      }
      const transmit = (data: string | Uint8Array<ArrayBuffer>): void => {
        if (!live || signal.aborted) return
        ws.send(data)
        handedBytes += typeof data === "string" ? data.length : data.byteLength
      }
      const sendHere: ControlSend = (frame) => transmit(JSON.stringify(frame))
      const sendChunk = (bytes: Uint8Array<ArrayBuffer>): void => transmit(bytes)
      const onClose = (event?: CloseEvent) => {
        if (event !== undefined) lastClose ??= `${event.code}${event.reason === "" ? "" : ` ${event.reason}`}`
        finish(!opened
          ? Effect.fail(new Error("relay closed the connection before it opened"))
          : refused === undefined ? Effect.succeed(admitted) : Effect.fail(new RelayRefusedError(refused)))
      }
      const onError = () => {
        if (!opened) finish(Effect.fail(new Error("relay connection failed")))
      }
      const onOpen = () => {
        if (!live || signal.aborted) return
        clearTimeout(openTimer)
        opened = true
        stopHeartbeat = heartbeat(ws, () => {
          lastClose = `${HEARTBEAT_CLOSE_CODE} ${HEARTBEAT_CLOSE_REASON}`
          ws.close(HEARTBEAT_CLOSE_CODE, HEARTBEAT_CLOSE_REASON)
          onClose()
        }, options.heartbeat, { handedBytes: () => handedBytes })
      }
      const onMessage = (event: MessageEvent) => {
        if (!live || signal.aborted) return
        const handle = Effect.gen(function*() {
          const frame = yield* Effect.try({
            try: () => {
              if (typeof event.data !== "string") throw new Error("the relay sent a binary frame on the control channel")
              return decodeJsonFrame(decodeRelayControlFrame, event.data)
            },
            catch: (error) => error,
          })
          switch (frame.type) {
            case "challenge": {
              const signature = yield* bridgeExternalPromise(() => identity.sign(runtimeAttachSigningBytes({ nonce: frame.nonce, runtimeId: identity.runtimeId, placementId: placement.id }))).owned
              yield* Effect.try({
                try: () => sendHere({ type: "attach", relayProtocolVersion: RELAY_PROTOCOL_VERSION, runtimeId: identity.runtimeId, publicKey: toBase64Url(identity.publicKey), placement, devices: options.devices(), signature: toBase64Url(signature) }),
                catch: (error) => error,
              })
              return
            }
            case "attached":
              yield* Effect.try({
                try: () => {
                  admitted = true
                  control = sendHere
                  attachedAt = Date.now()
                  pruneEndedChannels()
                  for (const channelId of endedChannels.keys()) sendHere({ type: "channel.ended", channelId })
                  // The first attach of the placement records at the default
                  // level; a reattach follows an interruption, which records
                  // or counts it.
                  const attached = { relayUrl, placement: placement.id, state: placement.state, devices: options.devices().length, ...(endedChannels.size === 0 ? {} : { reportedChannelEnds: endedChannels.size }) }
                  if (attachedBefore) log.debug("relay control channel attached", attached)
                  else log.info("relay control channel attached", attached)
                  attachedBefore = true
                  // The owner clears what the last failure left before the
                  // connected state publishes, so no view pairs the two.
                  options.onAttached?.(sendHere)
                  options.onConnection("connected")
                },
                catch: (error) => error,
              })
              return
            case "rejected":
              refused = frame.reason
              return
            case "open":
              yield* Effect.tryPromise({ try: () => options.onOpen(frame, sendHere), catch: (error) => error })
              return
            case "asset.request":
              yield* Effect.tryPromise({ try: () => answerAsset(sendHere, sendChunk, frame, served), catch: (error) => error })
              return
            case "pong":
              return
          }
        }).pipe(Effect.catch((error) => Effect.sync(() => {
          log.warn("relay control frame failed", { error: errorMessage(error) })
          ws.close(1002, "protocol error")
        })))
        Effect.runSync(Effect.forkIn(handle, scope, { startImmediately: true }))
      }
      // The Promise helpers cannot cancel their timers or listeners, so this
      // scope owns the control socket's open wait and heartbeat together.
      const openTimer = setTimeout(() => finish(Effect.fail(new Error("relay did not accept the connection in time"))), OPEN_TIMEOUT_MS)
      yield* Effect.addFinalizer(() => Effect.sync(() => {
        live = false
        clearTimeout(openTimer)
        stopHeartbeat?.()
        ws.removeEventListener("open", onOpen)
        ws.removeEventListener("error", onError)
        ws.removeEventListener("close", onClose)
        ws.removeEventListener("message", onMessage)
        control = undefined
      }))
      ws.addEventListener("open", onOpen, { once: true })
      ws.addEventListener("error", onError)
      ws.addEventListener("close", onClose, { once: true })
      ws.addEventListener("message", onMessage)
      return yield* Deferred.await(ended)
    }))
  }

  return {
    send(frame) {
      if (control === undefined) return false
      control(frame)
      return true
    },
    channelOpened(channelId) {
      openDials.set(channelId, (openDials.get(channelId) ?? 0) + 1)
      endedChannels.delete(channelId)
      return ({ abrupt }) => {
        const stillOpen = (openDials.get(channelId) ?? 1) - 1
        if (stillOpen > 0) openDials.set(channelId, stillOpen)
        else openDials.delete(channelId)
        if (!abrupt || stillOpen > 0 || disposed) return
        pruneEndedChannels()
        endedChannels.set(channelId, now())
        control?.({ type: "channel.ended", channelId })
        log.info("relay data channel end reported", { placement: placementId, channel: channelId, sent: control !== undefined })
      }
    },
    connected() {
      return control !== undefined
    },
    reconcile(closeReason) {
      if (!wanted()) {
        loop?.stop(1000, closeReason)
        return
      }
      const relayUrl = options.relayUrl()
      if (loop !== undefined && dialedRelayUrl !== undefined && dialedRelayUrl !== relayUrl) {
        // The loop's end dials again while a connection is still wanted, and
        // that dial reads the new relay.
        log.info("relay control channel redialing a changed relay", { placement: placementId, from: new URL(dialedRelayUrl).host, to: new URL(relayUrl).host })
        dialedRelayUrl = undefined
        loop.stop(1000, "relay changed")
        return
      }
      ensureLoop()
    },
    async dispose(reason) {
      disposed = true
      const live = loop !== undefined
      loop?.stop(1001, reason)
      await loop?.done
      interruptions.end()
      if (live) log.info("relay control channel closed", { placement: placementId, reason })
    },
  }
}

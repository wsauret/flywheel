import { Effect, type Scope } from "effect"

import { RELAY_HEARTBEAT, relayChannelStreams, type HeartbeatTiming, type RelayChannelSocket, type RelayChannelStreams } from "../../../protocol/modules/remote/relay-channel.js"
import { withStatedHeartbeat, type ChannelAcceptFrame, type OpenFrame } from "../../../protocol/modules/remote/relay-protocol.js"
import type { RelayControlChannel } from "./relay-control-channel.js"

const OPEN_TIMEOUT_MS = 15_000

/** One data channel this machine dialed for the relay's `open`. */
export interface DialedChannel {
  readonly ws: RelayChannelSocket
  readonly streams: RelayChannelStreams
}

/** Dials the data channel the relay named in `open` and proves it is ours,
 *  for every owner that answers an `open`: a project's placement and the
 *  account service's machine placement. The binary lane is installed before
 *  the accept frame goes out, because the relay may flush the device's first
 *  sealed frame the moment it accepts. The scope owns the socket: its release
 *  closes it, with `stopping` saying whether the owner is going away.
 *
 *  The channel keeps the relay heartbeat and states it in the URL it dials.
 *  This end is the one whose link can die without the relay seeing a close:
 *  the heartbeat then ends the channel here, and its silence lets the relay
 *  close the device's side within the same deadline, so the device dials
 *  again in seconds instead of waiting out the runtime protocol's minute.
 *
 *  The edge can also drop this socket at once while the relay hears nothing.
 *  This end then sees the connection end with no close handshake, and tells
 *  the relay through `control`, the control channel whose `open` it answered,
 *  so the relay closes the device's side at once. */
export function dialRelayDataChannel(options: {
  readonly connect: (url: string) => RelayChannelSocket
  readonly relayUrl: string
  readonly runtimeId: string
  readonly frame: OpenFrame
  readonly control: Pick<RelayControlChannel, "channelOpened">
  readonly stopping: () => boolean
  /** The contract's timing unless a test needs a faster one. */
  readonly heartbeat?: HeartbeatTiming
}): Effect.Effect<DialedChannel, unknown, Scope.Scope> {
  const timing = options.heartbeat ?? RELAY_HEARTBEAT
  return Effect.gen(function*() {
    const ws = yield* Effect.acquireRelease(
      Effect.try({ try: () => options.connect(withStatedHeartbeat(`${options.relayUrl}/channel/${options.runtimeId}`, timing.intervalMs)), catch: (error) => error }),
      (socket) => Effect.sync(() => {
        if (socket.readyState < WebSocket.CLOSING) socket.close(options.stopping() ? 1001 : 1000, options.stopping() ? "runtime stopping" : "")
      }),
    )
    yield* Effect.callback<void, Error>((resume) => {
      const settle = (result: Effect.Effect<void, Error>) => { cleanup(); resume(result) }
      const opened = () => settle(Effect.void)
      const failed = () => settle(Effect.fail(new Error("relay connection failed before opening")))
      const timer = setTimeout(() => settle(Effect.fail(new Error("relay did not accept the connection in time"))), OPEN_TIMEOUT_MS)
      ws.addEventListener("open", opened, { once: true })
      ws.addEventListener("error", failed, { once: true })
      ws.addEventListener("close", failed, { once: true })
      const cleanup = () => {
        clearTimeout(timer)
        ws.removeEventListener("open", opened)
        ws.removeEventListener("error", failed)
        ws.removeEventListener("close", failed)
      }
      return Effect.sync(cleanup)
    })
    ws.binaryType = "arraybuffer"
    const streams = relayChannelStreams(ws, timing)
    void streams.closed.then(options.control.channelOpened(options.frame.channelId))
    const acceptFrame: ChannelAcceptFrame = { type: "accept", runtimeId: options.runtimeId, channelId: options.frame.channelId, ticket: options.frame.ticket }
    ws.send(JSON.stringify(acceptFrame))
    return { ws, streams }
  })
}

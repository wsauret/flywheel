import type { ServerWebSocket } from "bun"

import type { RelayChannelSocket } from "../../../../../src/protocol/modules/remote/relay-channel.js"

import {
  claimedRelayProtocolVersion,
  decodeChannelAcceptFrame,
  decodeDeviceFrame,
  decodeJsonFrame,
  decodeRuntimeControlFrame,
  deviceAttachSigningBytes,
  fromBase64Url,
  keyDigest,
  ownedBytes,
  RELAY_PING,
  RELAY_PONG,
  RELAY_PROTOCOL_VERSION,
  runtimeAttachSigningBytes,
  toBase64Url,
  type Placement,
  type RelayControlFrame,
  type RelayDeviceFrame,
  type RelayRejectReason,
} from "../../../../../src/protocol/modules/remote/relay-protocol.js"

/** An in-process relay speaking the relay contract, for the runtime's tests.
 *
 *  It does what the Worker does and nothing the Worker does not: challenge,
 *  verify a signature, admit against the allowlist the runtime sent, join a
 *  device to a runtime with one `open`, hand a dormant placement's `decline`
 *  back to the parked device, report presence per placement with a runtime's
 *  live word beating a host's dormant one, and pump binary frames it never
 *  reads. It records every pumped frame so a test can assert that the
 *  transcript never appeared on the wire in the clear. */

type Role = "runtime" | "device" | "channel"

interface Attachment {
  readonly role: Role
  nonce: string
  runtimeId?: string
  placement?: Placement
  devices?: Set<string>
  presence?: boolean
  peer?: ServerWebSocket<Attachment>
  channelId?: string
  /** Ended by `severChannel`: the relay never hears this close. */
  severed?: boolean
  pending: Uint8Array[]
}

interface PendingChannel {
  readonly device: ServerWebSocket<Attachment>
  readonly runtime: ServerWebSocket<Attachment>
  readonly ticket: string
}

export interface RelayStub {
  readonly url: string
  /** Every binary frame that crossed the pump, in arrival order. */
  readonly pumped: Uint8Array[]
  /** The URL of every data channel a runtime dialed, oldest first. */
  readonly channelUrls: string[]
  /** The URL of every control socket a runtime dialed, oldest first. */
  readonly controlUrls: string[]
  /** The newest attached control socket per runtime id. */
  readonly runtimes: Map<string, ServerWebSocket<Attachment>>
  /** Every attached control socket, oldest first. */
  readonly controls: ServerWebSocket<Attachment>[]
  readonly pairingWindows: Map<string, string>
  /** What presence reports for a runtime id right now. */
  placements(runtimeId: string): Placement[]
  /** Drops the runtime's newest control socket, as a relay restart would. */
  dropRuntime(runtimeId: string): void
  /** Ends the newest data channel's connection with no close frame and
   *  leaves its device attached, as the edge does when it drops a machine's
   *  socket and the Worker never hears a close. */
  severChannel(): void
  /** The channel ids runtimes reported ended, in arrival order. */
  readonly endedChannels: string[]
  /** While false, pings go unanswered, as a half-open socket would leave them. */
  answerPings: boolean
  /** While set, every runtime attach is refused with this reason, as a relay
   *  on another contract or with a different opinion of the identity would. */
  refuseRuntime: RelayRejectReason | undefined
  /** How many runtime attach frames arrived, refused or admitted. */
  attachAttempts: number
  stop(): void
}

async function verify(publicKey: string, signature: string, bytes: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", ownedBytes(fromBase64Url(publicKey)), { name: "Ed25519" }, false, ["verify"])
    return await crypto.subtle.verify("Ed25519", key, ownedBytes(fromBase64Url(signature)), ownedBytes(bytes))
  } catch {
    return false
  }
}

export function startRelayStub(): RelayStub {
  const runtimes = new Map<string, ServerWebSocket<Attachment>>()
  const controls: ServerWebSocket<Attachment>[] = []
  const pairingWindows = new Map<string, string>()
  const channels = new Map<string, PendingChannel>()
  const pumped: Uint8Array[] = []
  const send = (ws: ServerWebSocket<Attachment>, frame: RelayControlFrame | RelayDeviceFrame) => ws.send(JSON.stringify(frame))
  const reject = (ws: ServerWebSocket<Attachment>, reason: RelayRejectReason) => {
    send(ws, { type: "rejected", reason })
    ws.close(1008, reason)
  }
  const controlsOf = (runtimeId: string) => controls.filter((ws) => ws.data.runtimeId === runtimeId && ws.data.placement !== undefined)
  /** A runtime's live word beats the host's dormant one; among equals the newest wins. */
  const serving = (runtimeId: string, placementId: string) => {
    const same = controlsOf(runtimeId).filter((ws) => ws.data.placement!.id === placementId)
    return same.findLast((ws) => ws.data.placement!.state === "live") ?? same.at(-1)
  }
  const placements = (runtimeId: string): Placement[] => {
    const ids = [...new Set(controlsOf(runtimeId).map((ws) => ws.data.placement!.id))]
    return ids.flatMap((id) => {
      const socket = serving(runtimeId, id)
      return socket ? [socket.data.placement!] : []
    })
  }
  const devicesOf = (runtimeId: string) => controls.findLast((ws) => ws.data.runtimeId === runtimeId)?.data.devices
  const broadcastPresence = (runtimeId: string) => {
    for (const ws of watchers) if (ws.data.runtimeId === runtimeId) send(ws, { type: "presence", placements: placements(runtimeId) })
  }
  const watchers = new Set<ServerWebSocket<Attachment>>()
  const channelUrls: string[] = []
  const accepted: ServerWebSocket<Attachment>[] = []
  const endedChannels: string[] = []
  const controlUrls: string[] = []
  const server = Bun.serve<Attachment>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      // Paths carry the runtime id the Worker routes on; the stub serves one
      // runtime and reads the role alone.
      const [, first] = new URL(request.url).pathname.split("/")
      const role: Role | undefined = first === "runtime" ? "runtime" : first === "device" ? "device" : first === "channel" ? "channel" : undefined
      if (!role) return new Response("not found", { status: 404 })
      if (role === "channel") channelUrls.push(request.url)
      if (role === "runtime") controlUrls.push(request.url)
      return srv.upgrade(request, { data: { role, nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(32))), pending: [] } }) ? undefined : new Response("websocket only", { status: 426 })
    },
    websocket: {
      open(ws) {
        if (ws.data.role !== "channel") send(ws, { type: "challenge", nonce: ws.data.nonce })
      },
      message(ws, message) {
        void (async () => {
          if (typeof message !== "string") {
            const bytes = new Uint8Array(message)
            pumped.push(bytes)
            if (ws.data.peer) ws.data.peer.send(bytes)
            else ws.data.pending.push(bytes)
            return
          }
          if (message === RELAY_PING) {
            if (stub.answerPings) ws.send(RELAY_PONG)
            return
          }
          if (ws.data.role === "runtime") {
            // The Worker reads the version claim before the strict decode, so
            // an older build hears protocol_version rather than malformed.
            const value: unknown = JSON.parse(message)
            const claimed = claimedRelayProtocolVersion(value)
            if (claimed !== undefined && claimed !== RELAY_PROTOCOL_VERSION) return reject(ws, "protocol_version")
            const frame = decodeRuntimeControlFrame(value)
            if (frame.type === "attach") {
              stub.attachAttempts += 1
              if (stub.refuseRuntime !== undefined) return reject(ws, stub.refuseRuntime)
              if (await keyDigest(fromBase64Url(frame.publicKey)) !== frame.runtimeId) return reject(ws, "bad_signature")
              if (!(await verify(frame.publicKey, frame.signature, runtimeAttachSigningBytes({ nonce: ws.data.nonce, runtimeId: frame.runtimeId, placementId: frame.placement.id })))) return reject(ws, "bad_signature")
              ws.data.runtimeId = frame.runtimeId
              ws.data.placement = frame.placement
              ws.data.devices = new Set(frame.devices)
              runtimes.set(frame.runtimeId, ws)
              controls.push(ws)
              send(ws, { type: "attached" })
              broadcastPresence(frame.runtimeId)
              return
            }
            if (frame.type === "devices") ws.data.devices = new Set(frame.devices)
            if (frame.type === "pairing.open" && ws.data.runtimeId) pairingWindows.set(frame.windowId, ws.data.runtimeId)
            if (frame.type === "pairing.close") pairingWindows.delete(frame.windowId)
            if (frame.type === "channel.ended") {
              endedChannels.push(frame.channelId)
              const channel = accepted.find((candidate) => candidate.data.channelId === frame.channelId)
              channel?.data.peer?.close(1000, "peer closed 1006: the machine's side ended")
            }
            if (frame.type === "decline") {
              const pending = channels.get(frame.channelId)
              if (!pending || pending.runtime !== ws) return
              channels.delete(frame.channelId)
              reject(pending.device, frame.reason === "starting" ? "runtime_starting" : "runtime_unavailable")
            }
            return
          }
          if (ws.data.role === "device") {
            const frame = decodeJsonFrame(decodeDeviceFrame, message)
            if (frame.type === "ping") return
            const channelId = toBase64Url(crypto.getRandomValues(new Uint8Array(9)))
            const ticket = toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
            if (frame.type === "pair") {
              const announcer = controlsOf(frame.runtimeId).at(-1)
              if (!announcer) return reject(ws, "runtime_offline")
              if (pairingWindows.get(frame.windowId) !== frame.runtimeId) return reject(ws, "pairing_window_closed")
              pairingWindows.delete(frame.windowId)
              channels.set(channelId, { device: ws, runtime: announcer, ticket })
              send(announcer, { type: "open", channelId, ticket, kind: "pairing", windowId: frame.windowId })
              return
            }
            if (!(await verify(frame.publicKey, frame.signature, deviceAttachSigningBytes({ nonce: ws.data.nonce, runtimeId: frame.runtimeId, deviceId: frame.deviceId })))) return reject(ws, "bad_signature")
            const allowlist = devicesOf(frame.runtimeId)
            if (!allowlist) return reject(ws, "runtime_offline")
            if (!allowlist.has(frame.deviceId)) return reject(ws, "device_not_paired")
            if (frame.type === "presence") {
              ws.data.runtimeId = frame.runtimeId
              ws.data.presence = true
              watchers.add(ws)
              send(ws, { type: "presence", placements: placements(frame.runtimeId) })
              return
            }
            const runtime = serving(frame.runtimeId, frame.placementId)
            if (!runtime) return reject(ws, "runtime_offline")
            channels.set(channelId, { device: ws, runtime, ticket })
            send(runtime, { type: "open", channelId, ticket, kind: "device", deviceId: frame.deviceId })
            return
          }
          // A runtime dialing a data channel: one accept frame, then the pump.
          const frame = decodeJsonFrame(decodeChannelAcceptFrame, message)
          const pending = channels.get(frame.channelId)
          if (!pending || pending.ticket !== frame.ticket) {
            ws.close(1008, "unknown channel")
            return
          }
          channels.delete(frame.channelId)
          ws.data.channelId = frame.channelId
          accepted.push(ws)
          ws.data.peer = pending.device
          pending.device.data.peer = ws
          send(pending.device, { type: "attached" })
          for (const early of pending.device.data.pending) ws.send(early)
          pending.device.data.pending = []
        })().catch(() => reject(ws, "malformed"))
      },
      close(ws) {
        watchers.delete(ws)
        const index = controls.indexOf(ws)
        if (index >= 0) controls.splice(index, 1)
        if (ws.data.runtimeId && runtimes.get(ws.data.runtimeId) === ws) {
          const remaining = controlsOf(ws.data.runtimeId).at(-1)
          if (remaining) runtimes.set(ws.data.runtimeId, remaining)
          else runtimes.delete(ws.data.runtimeId)
        }
        if (ws.data.role === "runtime" && ws.data.runtimeId) broadcastPresence(ws.data.runtimeId)
        if (!ws.data.severed) ws.data.peer?.close(1000)
      },
    },
  })
  // The message handler reads `stub.answerPings` only after this returns.
  const stub: RelayStub = {
    url: `ws://127.0.0.1:${server.port}`,
    pumped,
    channelUrls,
    controlUrls,
    runtimes,
    controls,
    pairingWindows,
    placements,
    answerPings: true,
    refuseRuntime: undefined,
    attachAttempts: 0,
    dropRuntime(runtimeId) {
      runtimes.get(runtimeId)?.close(1012, "relay restarting")
    },
    severChannel() {
      const channel = accepted.at(-1)
      if (!channel) throw new Error("no data channel to sever")
      channel.data.severed = true
      channel.terminate()
    },
    endedChannels,
    stop() {
      server.stop(true)
    },
  }
  return stub
}

/** A relay socket whose dial fails at once. */
export class FailedRelaySocket extends EventTarget implements RelayChannelSocket {
  readyState: WebSocket["readyState"] = WebSocket.CONNECTING
  binaryType: BinaryType = "blob"
  bufferedAmount = 0

  constructor() {
    super()
    queueMicrotask(() => { this.dispatchEvent(new Event("error")) })
  }

  send(): void {}
  close(): void { this.readyState = WebSocket.CLOSED }
}

/** A relay socket that never opens, so a test sees where a dial went without
 *  contacting any relay. */
export class PendingRelaySocket extends EventTarget implements RelayChannelSocket {
  readyState: WebSocket["readyState"] = WebSocket.CONNECTING
  binaryType: BinaryType = "blob"
  bufferedAmount = 0

  send(): void {}
  close(): void { this.readyState = WebSocket.CLOSED }
}

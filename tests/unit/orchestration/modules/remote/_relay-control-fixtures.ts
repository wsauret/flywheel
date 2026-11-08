import { createRelayControlChannel, linkConnection, linkFailure, type RelayControlChannelOptions, type RelayLink } from "../../../../../src/orchestration/modules/remote/relay-control-channel.js"
import type { RemoteIdentity } from "../../../../../src/orchestration/modules/remote/remote-identity.js"
import { RELAY_PING } from "../../../../../src/protocol/modules/remote/relay-protocol.js"

/** A relay control channel over a fake control socket that the test drives:
 *  every link it publishes, read as the connection a person sees and the
 *  failure it carries. */

export class ControlSocket extends EventTarget {
  readyState: WebSocket["readyState"] = WebSocket.CONNECTING
  bufferedAmount = 0
  /** Every text frame but the heartbeat's pings, which go to `pings`. */
  readonly sent: string[] = []
  readonly pings: string[] = []
  readonly binary: Uint8Array[] = []
  readonly closes: { code: number | undefined; reason: string | undefined }[] = []
  send(data: Parameters<WebSocket["send"]>[0]): void {
    if (data === RELAY_PING) this.pings.push(data)
    else if (typeof data === "string") this.sent.push(data)
    else if (ArrayBuffer.isView(data)) this.binary.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  }
  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
    this.readyState = WebSocket.CLOSING
  }
  open(): void {
    this.readyState = WebSocket.OPEN
    this.dispatchEvent(new Event("open"))
  }
  message(frame: unknown): void { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) })) }
  peerClose(): void {
    this.readyState = WebSocket.CLOSED
    this.dispatchEvent(new Event("close"))
  }
}

export const identity: RemoteIdentity = { runtimeId: "runtime", publicKey: new Uint8Array(32), sign: async () => new Uint8Array(64) }
export const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

export function fixture(overrides: Partial<RelayControlChannelOptions> = {}) {
  const sockets: ControlSocket[] = []
  const states: string[] = []
  const failures: { error: string; outcome: string }[] = []
  const links: RelayLink[] = []
  const options: RelayControlChannelOptions = {
    relayUrl: () => "wss://relay.invalid",
    identity: async () => identity,
    placement: () => ({ id: "placement", projectLabel: "Project", version: "test", protocolVersion: 2, state: "live" }),
    devices: () => ["device"],
    wanted: () => true,
    connect: () => {
      const ws = new ControlSocket()
      sockets.push(ws)
      return ws
    },
    onLink: (link) => {
      links.push(link)
      states.push(linkConnection(link))
      const failure = linkFailure(link)
      if (failure !== undefined && failure !== failures.at(-1)) failures.push(failure)
    },
    onOpen: async () => {},
    ...overrides,
  }
  return { channel: createRelayControlChannel(options), sockets, states, failures, links, options }
}

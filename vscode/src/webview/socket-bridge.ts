import net from "node:net"

import {
  createAccountAttachResponseReader,
  encodeAccountAttach,
} from "../../../src/protocol/account-attach.js"
import type { HostMessage, ViewMessage } from "../../../src/protocol/client/editor-host.js"
import type { RuntimeSocketTarget } from "../runtime/node-socket.js"

/** The extension host's half of the byte pump.
 *
 *  Each channel the webview opens is one `net` connection to the runtime's
 *  socket. Bytes move both ways as they arrive and are never decoded here: the
 *  RPC framing, MsgPack, and the protocol all live at the two ends, so the
 *  host cannot hold an opinion about what is in flight. A webview that
 *  reconnects opens a fresh channel rather than reusing a dead one, which is
 *  the same rule the client's connection applies to its own transport layer. */
export class SocketBridge {
  private readonly channels = new Map<number, net.Socket>()

  constructor(
    private readonly target: RuntimeSocketTarget,
    private readonly post: (message: HostMessage) => void,
  ) {}

  /** Handles one socket-lifecycle message from the view. Returns false for a
   *  message that is not the bridge's, so the caller can route the rest. */
  handle(message: ViewMessage): boolean {
    switch (message.type) {
      case "socket.open":
        this.open(message.id)
        return true
      case "socket.data":
        this.channels.get(message.id)?.write(message.bytes)
        return true
      case "socket.close":
        this.close(message.id)
        return true
      default:
        return false
    }
  }

  private open(id: number): void {
    if (this.channels.has(id)) return
    const socket = net.connect(this.target.socketPath)
    this.channels.set(id, socket)
    socket.setNoDelay(true)
    let opened = false
    const readiness = createAccountAttachResponseReader()
    socket.once("connect", () => {
      socket.write(encodeAccountAttach({
        intent: "runtime",
        projectRoot: this.target.projectRoot,
        credential: this.target.credential,
      }))
    })
    // A fresh view for every chunk: Node reuses its read buffers, and a
    // structured clone of a slice that is about to be overwritten is the one
    // kind of copy that must not be deferred.
    socket.on("data", (chunk: Buffer) => {
      const bytes = Uint8Array.from(chunk)
      if (opened) {
        this.post({ type: "socket.data", id, bytes })
        return
      }
      const result = readiness.push(bytes)
      if (result.kind === "pending" || result.kind === "starting") return
      if (result.kind === "failed") {
        this.settle(id, result.error)
        socket.destroy()
        return
      }
      if (result.kind === "busy" || result.kind === "retiring" || result.kind === "client") {
        this.settle(id, `account service returned a ${result.kind} response to a project attach`)
        socket.destroy()
        return
      }
      opened = true
      this.post({ type: "socket.opened", id })
      if (result.remainder.length > 0) this.post({ type: "socket.data", id, bytes: result.remainder })
    })
    socket.once("error", (cause) => this.settle(id, cause.message))
    socket.once("close", () => this.settle(id))
  }

  private close(id: number): void {
    const socket = this.channels.get(id)
    if (!socket) return
    this.channels.delete(id)
    socket.destroy()
  }

  /** Reports the end of a channel exactly once, whichever event says so first. */
  private settle(id: number, error?: string): void {
    if (!this.channels.has(id)) return
    this.channels.delete(id)
    this.post(error === undefined ? { type: "socket.closed", id } : { type: "socket.closed", id, error })
  }

  /** Ends every channel without reporting it to the page, which has gone. */
  closeAll(): void {
    const sockets = [...this.channels.values()]
    this.channels.clear()
    for (const socket of sockets) socket.destroy()
  }

  dispose(): void {
    this.closeAll()
  }
}

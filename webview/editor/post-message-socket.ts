import { Effect, Layer, Scope } from "effect"
import { Socket } from "effect/unstable/socket"

import type { HostMessage, ViewMessage } from "../../src/protocol/client/editor-host.js"

/** The webview's runtime transport: an Effect `Socket` over `postMessage`.
 *
 *  The extension host connects one `net` socket per channel and copies bytes
 *  both ways. From here that is indistinguishable from the socket itself, which
 *  is the point: the client's connection asks for a `Socket` layer and gets one,
 *  and the same connection code runs unchanged over a WebSocket in a browser.
 *
 *  The RPC layer rebuilds this layer on every attach, so each acquisition opens
 *  a fresh channel. A channel the host closed is never reused. */

interface ChannelHandlers {
  readonly opened: () => void
  readonly data: (bytes: Uint8Array) => void
  readonly closed: (error?: string) => void
}

/** The view's end of the bridge, shared by the socket layer and the host shell:
 *  it posts to the extension host and routes what comes back by channel id. */
export class ViewBridge {
  private nextChannel = 1
  private readonly channels = new Map<number, ChannelHandlers>()

  constructor(readonly post: (message: ViewMessage) => void) {}

  allocate(handlers: ChannelHandlers): number {
    const id = this.nextChannel
    this.nextChannel += 1
    this.channels.set(id, handlers)
    return id
  }

  release(id: number): void {
    this.channels.delete(id)
  }

  /** Routes one socket message. Returns false for anything that is not one. */
  handle(message: HostMessage): boolean {
    switch (message.type) {
      case "socket.opened":
        this.channels.get(message.id)?.opened()
        return true
      case "socket.data":
        this.channels.get(message.id)?.data(message.bytes)
        return true
      case "socket.closed":
        this.channels.get(message.id)?.closed(message.error)
        return true
      default:
        return false
    }
  }
}

interface OpenChannel {
  readonly id: number
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
}

function openChannel(bridge: ViewBridge): Effect.Effect<OpenChannel, Socket.SocketError, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.callback<OpenChannel, Socket.SocketError>((resume) => {
      let readController: ReadableStreamDefaultController<Uint8Array> | undefined
      let opened = false
      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          readController = controller
        },
      })
      const id = bridge.allocate({
        opened: () => {
          opened = true
          resume(Effect.succeed({ id, readable, writable }))
        },
        data: (bytes) => readController?.enqueue(bytes),
        closed: (error) => {
          if (!opened) {
            resume(Effect.fail(new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause: new Error(error ?? "channel closed before it opened") }) })))
            return
          }
          // A close after open ends the read side; the RPC layer treats that
          // as the lane ending and reconnects on a fresh channel.
          try {
            if (error === undefined) readController?.close()
            else readController?.error(new Error(error))
          } catch {
            // Already closed: the stream reached its end on its own.
          }
        },
      })
      const writable = new WritableStream<Uint8Array>({
        write(chunk) {
          bridge.post({ type: "socket.data", id, bytes: chunk })
        },
      })
      bridge.post({ type: "socket.open", id })
    }),
    (channel) => Effect.sync(() => {
      bridge.release(channel.id)
      bridge.post({ type: "socket.close", id: channel.id })
    }),
  )
}

/** A `Socket` layer whose every acquisition is a new channel to the runtime. */
export function postMessageSocketLayer(bridge: ViewBridge): Layer.Layer<Socket.Socket> {
  return Layer.effect(Socket.Socket)(Socket.fromTransformStream(
    openChannel(bridge).pipe(Effect.map((channel) => ({ readable: channel.readable, writable: channel.writable }))),
  ))
}

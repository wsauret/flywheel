import { Effect, Latch, Layer, Queue, Schema, Scope } from "effect"
import { RpcMessage, RpcSerialization, RpcServer } from "effect/rpc"
import type { Socket } from "effect/socket"
import { SocketServer } from "effect/socket"

import { Log } from "../../infra/log.js"
import { MutationFilesQuerySchema, MutationFilesResultSchema, MutationPatchWindowQuerySchema, MutationPatchWindowResultSchema } from "../../protocol/mutation-evidence-protocol-types.js"
import { fitMutationEvidenceWindow } from "../../protocol/mutation-evidence-window.js"
import { SessionChangesQuerySchema, SessionChangesResultSchema } from "../../protocol/session-changes-protocol-types.js"
import { SESSION_CONTENT_WINDOW_BYTES } from "../../infra/session-content-schema.js"

type FromServerEncoded = RpcMessage.FromServerEncoded
type FromClientEncoded = RpcMessage.FromClientEncoded

/** More than twice the largest measured bandwidth-delay product of a lane
 *  (151 KB/s peak event rate over a 300 ms phone round trip is 45 KB), so a
 *  link that keeps up never holds. One eighth of the relay channel writer's
 *  1 MiB high-water mark, so that writer never parks before the window does. */
const STREAM_WINDOW_BYTES = 128 * 1024

/** The unacknowledged chunks of one stream request on one connection. */
interface StreamCredit {
  unacknowledged: number
  /** Encoded sizes of the unacknowledged chunks, oldest first. */
  readonly sizes: Array<number>
  readonly open: Latch.Latch
}

const log = Log.create({ service: "runtime-protocol-socket-server" })
const isEvidenceQuery = Schema.is(Schema.Union([MutationFilesQuerySchema, MutationPatchWindowQuerySchema, SessionChangesQuerySchema]))

/** The RPC server's transport over the current `SocketServer` for every
 *  serving of `RuntimeProtocolRpc`, with a byte window in place of
 *  stop-and-wait stream acknowledgements.
 *
 *  This is Effect's `RpcServer.layerProtocolSocketServer` (effect 4.1.2,
 *  `RpcServer.ts` `makeSocketProtocol`) with one change. Effect
 *  sends one stream chunk and then waits for the client's `Ack` before it
 *  takes the next batch, so a lane carries at most one batch for each round
 *  trip, and every frame of a batch waits for the round trip before it. Here
 *  the client's `Ack` is credit for a window of encoded bytes: a stream's
 *  chunks go out at once while fewer than `STREAM_WINDOW_BYTES` are
 *  unacknowledged, and the stream holds only while a full window is.
 *
 *  The acknowledgement stays end to end. The client sends one `Ack` for each
 *  chunk, in chunk order, only after the chunk enters its bounded stream
 *  buffer; the counterpart that keeps this contract for Flywheel's clients is
 *  `src/protocol/client/socket-protocol.ts`, and ARCH-PROTOCOL-022 states it. This
 *  protocol reads every `Ack` itself and reports `supportsAck: false`, so
 *  `RpcServer` keeps no latch of its own and the window is the one owner of
 *  stream flow control. */
export const runtimeProtocolSocketServer: Layer.Layer<RpcServer.Protocol, never, RpcSerialization.RpcSerialization | SocketServer.SocketServer> = Layer.effect(RpcServer.Protocol)(Effect.gen(function*() {
  const server = yield* SocketServer.SocketServer
  const serialization = yield* RpcSerialization.RpcSerialization
  const encodeDefect = Schema.encodeSync(serialization.codecFor(Schema.Defect()))
  const disconnects = yield* Queue.make<number>()

  let nextClientId = 0
  const clients = new Map<number, { readonly write: (response: FromServerEncoded) => Effect.Effect<void> }>()
  const clientIds = new Set<number>()

  let writeRequest!: (clientId: number, message: FromClientEncoded) => Effect.Effect<void>

  const onSocket = function*(socket: Socket.Socket) {
    const scope = yield* Effect.scope
    const parser = serialization.makeUnsafe()
    const id = nextClientId++
    // The window state lives in the connection's scope and ends with it. A
    // stream still held at the connection's end is interrupted by RpcServer
    // when it reads the disconnect.
    const credits = new Map<string | number, StreamCredit>()
    const evidenceQueries = new Map<string | number, { readonly type: "mutationFiles" | "mutationPatchWindow" | "sessionChanges"; readonly maxBytes: number }>()
    const stats = { chunks: 0, holds: 0, maxUnacknowledgedBytes: 0 }
    yield* Scope.addFinalizerExit(scope, () => {
      clients.delete(id)
      clientIds.delete(id)
      credits.clear()
      evidenceQueries.clear()
      log.debug("runtime protocol connection ended", { clientId: id, ...stats })
      return Queue.offer(disconnects, id)
    })

    const writer = yield* socket.writer
    const encodeAndWrite = (response: FromServerEncoded, onEncoded?: (length: number) => void): Effect.Effect<void> => {
      let encoded: string | Uint8Array | undefined
      const evidence = response._tag === "Exit" ? evidenceQueries.get(response.requestId) : undefined
      try {
        if (response._tag === "Exit") evidenceQueries.delete(response.requestId)
        if (evidence && response._tag === "Exit" && response.exit._tag === "Success") {
          const result = evidence.type === "sessionChanges"
            ? Schema.decodeUnknownSync(SessionChangesResultSchema)(response.exit.value)
            : evidence.type === "mutationFiles"
            ? Schema.decodeUnknownSync(MutationFilesResultSchema)(response.exit.value)
            : Schema.decodeUnknownSync(MutationPatchWindowResultSchema)(response.exit.value)
          // The transport owns both the actual request id and the active codec.
          // Keep the measured bytes, rather than encode the fitted result again.
          fitMutationEvidenceWindow(result, evidence.maxBytes, window => {
            encoded = parser.encode({ ...response, exit: { _tag: "Success", value: window } })
            return typeof encoded === "string" ? new TextEncoder().encode(encoded).byteLength : encoded?.byteLength ?? 0
          })
        } else encoded = parser.encode(response)
        if (encoded === undefined) return Effect.void
        // Counted before the write, so no acknowledgement can arrive for a
        // chunk the window has not counted. A text serialization counts UTF-16
        // units, which is close enough to bytes for a bound.
        onEncoded?.(encoded.length)
      } catch (cause) {
        // SAFETY: the parser encodes every defect response; only a response
        // the serialization drops, which a defect never is, encodes to nothing.
        encoded = parser.encode(evidence && response._tag === "Exit"
          ? RpcMessage.ResponseExitDieEncoded({ requestId: RpcMessage.RequestId(response.requestId), encodedDefect: encodeDefect(cause) })
          : RpcMessage.ResponseDefectEncoded(encodeDefect(cause)))!
      }
      // As in Effect's protocol, a write to a socket that failed is a defect:
      // the connection's run fails with the same socket and ends the client.
      return Effect.orDie(writer.write(encoded)) // oxlint-disable-line flywheel/no-effect-escape-hatch -- boundary: RpcServer.Protocol send has no error channel; the socket run reports the failure
    }

    // Write first, then hold. RpcServer takes a stream's next batch only after
    // `send` returns, so frames that arrive during a hold wait in the stream's
    // own queue, where an overflow is handled, never in a batch already taken.
    // The hold starts after the write returns, so it holds no writer lock and
    // a query reply on the same connection goes out during it.
    const writeChunk = (response: RpcMessage.ResponseChunkEncoded): Effect.Effect<void> => {
      let credit = credits.get(response.requestId)
      if (!credit) {
        credit = { unacknowledged: 0, sizes: [], open: Latch.makeUnsafe(true) }
        credits.set(response.requestId, credit)
      }
      const owned = credit
      return Effect.flatMap(encodeAndWrite(response, (length) => {
        owned.unacknowledged += length
        owned.sizes.push(length)
        stats.chunks += 1
        stats.maxUnacknowledgedBytes = Math.max(stats.maxUnacknowledgedBytes, owned.unacknowledged)
      }), () => {
        if (owned.unacknowledged < STREAM_WINDOW_BYTES) return Effect.void
        stats.holds += 1
        owned.open.closeUnsafe()
        return owned.open.await
      })
    }

    const write = (response: FromServerEncoded): Effect.Effect<void> => {
      if (response._tag === "Chunk") return writeChunk(response)
      if (response._tag === "Exit") credits.delete(response.requestId)
      return encodeAndWrite(response)
    }

    // Each `Ack` returns the oldest unacknowledged chunk of its request. An
    // `Ack` for a request that already exited has nothing left to return.
    const acknowledge = (requestId: string | number): void => {
      const credit = credits.get(requestId)
      if (!credit) return
      credit.unacknowledged -= credit.sizes.shift() ?? 0
      if (credit.unacknowledged < STREAM_WINDOW_BYTES) credit.open.openUnsafe()
    }

    clients.set(id, { write })
    clientIds.add(id)

    // Every inbound frame reaches `writeRequest` in arrival order; an `Ack` is
    // consumed here and never forwarded.
    const processData = (data: string | Uint8Array): Effect.Effect<void, Socket.SocketError> => {
      try {
        // SAFETY: The RPC serialization parser validates the client frame
        // before it returns the decoded protocol messages.
        const decoded = parser.decode(data) as ReadonlyArray<FromClientEncoded> // oxlint-disable-line typescript/consistent-type-assertions -- boundary: decoded wire frame from an RPC client
        if (decoded.length === 0) return Effect.void
        let i = 0
        return Effect.whileLoop({
          while: () => i < decoded.length,
          body: () => {
            // SAFETY: the loop runs only while `i` is below the length.
            const message = decoded[i++]!
            if (message._tag === "Request" && message.tag === "RuntimeQuery" && isEvidenceQuery(message.payload)) {
              evidenceQueries.set(message.id, { type: message.payload.type, maxBytes: message.payload.maxBytes ?? SESSION_CONTENT_WINDOW_BYTES })
            }
            if (message._tag !== "Ack") return writeRequest(id, message)
            acknowledge(message.requestId)
            return Effect.void
          },
          step: () => {},
        })
      } catch (cause) {
        // SAFETY: the parser encodes every defect response, as above.
        return writer.write(parser.encode(RpcMessage.ResponseDefectEncoded(encodeDefect(cause)))!)
      }
    }

    yield* Effect.gen(function*() {
      const { pull } = yield* socket.reader
      while (true) {
        const frames = yield* pull
        for (const frame of frames) yield* processData(frame)
      }
    }).pipe(
      Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
      Effect.orDie, // oxlint-disable-line flywheel/no-effect-escape-hatch -- boundary: as in Effect's protocol, a socket read failure ends this connection's scoped run
    )
  }

  const protocol = yield* RpcServer.Protocol.make((writeRequest_) => {
    writeRequest = writeRequest_
    return Effect.succeed({
      disconnects,
      send: (clientId, response) => {
        const client = clients.get(clientId)
        if (!client) return Effect.void
        return client.write(response)
      },
      end: () => Effect.void,
      clientIds: Effect.sync(() => clientIds),
      initialMessage: Effect.succeedNone,
      // The window above owns acknowledgements; RpcServer must not latch on them too.
      supportsAck: false,
      supportsTransferables: false,
      supportsSpanPropagation: true,
      supportsNotifications: true,
      codecFor: serialization.codecFor,
    })
  })
  yield* Effect.forkScoped(server.run(Effect.fnUntraced(onSocket, Effect.scoped)))
  return protocol
}))

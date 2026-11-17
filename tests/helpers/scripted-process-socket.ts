import { expect, spyOn } from "bun:test"

import { connectInternalProcessChannel, type InternalProcessChannelLimits, type InternalProcessDecoder, type InternalProcessEndpoint } from "../../src/infra/internal-process-channel.js"

/** The wire of one socket connection, as the test scripts it. */
export interface ScriptedSocketWire {
  /** Takes the bytes the endpoint writes and answers how many the socket
   *  accepted, as a Bun socket does: fewer than all of them holds the rest
   *  until `drain`, and a negative count is a failed write. */
  write(bytes: Uint8Array): number
  end?(): void
}

/** A connection of `connectInternalProcessChannel` whose socket the test
 *  drives: `receive` delivers peer bytes, `drain` reports that the socket
 *  takes writes again, and `lost` closes the socket. */
export interface ScriptedSocketConnection<Outgoing, Incoming> {
  readonly endpoint: InternalProcessEndpoint<Outgoing, Incoming>
  receive(bytes: Uint8Array): void
  drain(): void
  lost(): void
}

/** Connects the production channel over a scripted socket instead of a
 *  Unix socket or a named pipe, so a test controls when the peer reads. */
export async function connectScriptedSocket<Outgoing, Incoming>(options: InternalProcessChannelLimits & {
  readonly decode: InternalProcessDecoder<Incoming>
  readonly wire: ScriptedSocketWire
}): Promise<ScriptedSocketConnection<Outgoing, Incoming>> {
  // The channel reads only `write` and `end` of the socket it is given.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: Bun makes a Socket only for a connection it opened, so a scripted stand-in cannot be one
  const socket: Bun.Socket<undefined> = { write: (bytes: Uint8Array) => options.wire.write(bytes), end: () => { options.wire.end?.() } } as never
  let handlers: Bun.SocketHandler<unknown> | undefined
  const connect = spyOn(Bun, "connect").mockImplementation((input) => {
    handlers = input.socket
    return Promise.resolve(socket)
  })
  const opened = (): Bun.SocketHandler<unknown> => handlers ?? expect.unreachable("connectInternalProcessChannel did not connect")
  try {
    const endpoint = connectInternalProcessChannel<Outgoing, Incoming>({ ...options, path: "scripted-socket" })
    void opened().open?.(socket)
    return {
      endpoint: await endpoint,
      receive(bytes) { void opened().data?.(socket, Buffer.from(bytes)) },
      drain() { void opened().drain?.(socket) },
      lost() { void opened().close?.(socket, undefined) },
    }
  } finally {
    connect.mockRestore()
  }
}

/** The frames a production endpoint writes for `message`. */
export async function framesOf(message: unknown, limits: InternalProcessChannelLimits = {}): Promise<Uint8Array[]> {
  const frames: Uint8Array[] = []
  const connection = await connectScriptedSocket({
    ...limits,
    decode: (value) => value,
    wire: { write: (bytes) => { frames.push(bytes.slice()); return bytes.byteLength } },
  })
  await connection.endpoint.send(message)
  connection.endpoint.close()
  return frames
}

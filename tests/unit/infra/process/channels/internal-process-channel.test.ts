import { beforeAll, describe, expect, test } from "bun:test"

import { createMessagePortProcessEndpoint } from "../../../../../src/infra/process/channels/internal-process-channel.js"
import { connectScriptedSocket, framesOf } from "../../../../helpers/scripted-process-socket.js"

const decodeMessage = (value: unknown): { readonly value: string } | undefined => {
  if (typeof value !== "object" || value === null || !("value" in value) || typeof value.value !== "string") return undefined
  return { value: value.value }
}

/** A socket endpoint whose peer the test writes to, with every message it
 *  delivered and the reason it closed, if it did. */
async function receiver(limits: { readonly maxFrameBytes?: number; readonly maxMessageBytes?: number } = {}) {
  const connection = await connectScriptedSocket<{ value: string }, { value: string }>({
    ...limits,
    decode: decodeMessage,
    wire: { write: (bytes) => bytes.byteLength },
  })
  const received: { readonly value: string }[] = []
  const closes: string[] = []
  connection.endpoint.onMessage((message) => { received.push(message) })
  connection.endpoint.onClose((reason) => { closes.push(reason.message) })
  return { connection, received, closes }
}

function joined(chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return bytes
}

describe("internal process channel framing", () => {
  test("decodes fragmented and coalesced length-prefixed MessagePack frames", async () => {
    const { connection, received, closes } = await receiver({ maxFrameBytes: 64 })
    const [first] = await framesOf({ value: "first" })
    const [second] = await framesOf({ value: "second" })
    if (!first || !second) throw new Error("expected one frame per message")
    const bytes = joined([first, second])

    connection.receive(bytes.subarray(0, 2))
    connection.receive(bytes.subarray(2, first.length + 3))
    connection.receive(bytes.subarray(first.length + 3))
    expect(received).toEqual([{ value: "first" }, { value: "second" }])
    expect(closes).toEqual([])
  })

  test("A frame larger than the channel limit is refused and the endpoint closes", async () => {
    const { connection, received, closes } = await receiver({ maxFrameBytes: 4 })
    connection.receive(new Uint8Array([0, 0, 0, 6]))

    expect(closes).toEqual(["internal process endpoint received an invalid frame"])
    expect(received).toEqual([])
  })

  test("a message the decoder refuses closes the endpoint before delivery", async () => {
    const { connection, received, closes } = await receiver({ maxFrameBytes: 64 })
    for (const frame of await framesOf({ wrong: true })) connection.receive(frame)

    expect(closes).toEqual(["internal process endpoint received an invalid frame"])
    expect(received).toEqual([])
  })

  test("splits a message larger than one frame and reassembles it in order", async () => {
    const { connection, received } = await receiver({ maxFrameBytes: 8 })
    const value = "a message far longer than eight bytes of frame"
    const frames = await framesOf({ value }, { maxFrameBytes: 8 })
    expect(frames.length).toBeGreaterThan(3)
    for (const frame of frames) expect(frame.byteLength).toBeLessThanOrEqual(4 + 1 + 8)
    for (const frame of frames) connection.receive(frame)
    expect(received).toEqual([{ value }])
  })

  test("bounds reassembly by the message ceiling, not the frame size", async () => {
    const value = "a message far longer than eight bytes of frame"
    await expect(framesOf({ value }, { maxFrameBytes: 8, maxMessageBytes: 16 })).rejects.toThrow("exceeds 16 bytes")
    const { connection, received, closes } = await receiver({ maxFrameBytes: 8, maxMessageBytes: 16 })
    for (const frame of await framesOf({ value }, { maxFrameBytes: 8 })) connection.receive(frame)

    expect(closes).toEqual(["internal process endpoint received an invalid frame"])
    expect(received).toEqual([])
  })
})

describe("typed process endpoint", () => {
  test("settles pending sends and close observers when the endpoint closes", async () => {
    const channel = new MessageChannel()
    const endpoint = createMessagePortProcessEndpoint<{ value: string }, { value: string }>({
      port: channel.port1,
      decode: decodeMessage,
    })
    const closed = endpoint.closed
    endpoint.close("test close")
    await closed
    await expect(endpoint.send({ value: "late" })).rejects.toThrow("test close")
    channel.port2.close()
  })
})

describe("socket endpoint backpressure", () => {
  let frameBytes = 0
  beforeAll(async () => { frameBytes = (await framesOf({ value: "x" }))[0]!.byteLength })

  function heldSocket() {
    let held = true
    const written: number[] = []
    return {
      written,
      release() { held = false },
      wire: {
        write(bytes: Uint8Array) {
          if (held) return 0
          written.push(bytes.byteLength)
          return bytes.byteLength
        },
        end() {},
      },
    }
  }

  test("a send over the queue bound waits for the peer to drain instead of failing", async () => {
    const io = heldSocket()
    const connection = await connectScriptedSocket<{ value: string }, { value: string }>({
      wire: io.wire, decode: decodeMessage, maxFrameBytes: 64, maxMessageBytes: 64, maxQueuedBytes: frameBytes * 2,
    })
    const sends = [1, 2, 3].map(() => connection.endpoint.send({ value: "x" }))
    const settled = { count: 0 }
    const countSettled = (): void => { settled.count += 1 }
    for (const send of sends) void send.then(countSettled)
    await Bun.sleep(5)
    expect(settled.count).toBe(0)

    io.release()
    connection.drain()
    await Promise.all(sends)
    expect(io.written).toEqual([frameBytes, frameBytes, frameBytes])
  })

  test("a small send made while a larger one waits for room is written after it", async () => {
    const io = heldSocket()
    const connection = await connectScriptedSocket<{ value: string }, { value: string }>({
      wire: io.wire, decode: decodeMessage, maxFrameBytes: 64, maxMessageBytes: 64, maxQueuedBytes: frameBytes * 3,
    })
    const wide = { value: "x".repeat(30) }
    const large = (await framesOf(wide))[0]!.byteLength
    const held = connection.endpoint.send({ value: "x" })
    // The first message holds its bytes in the queue: the second does not
    // fit beside it, and the third does.
    await new Promise((resolve) => setImmediate(resolve))
    const sends = [held, connection.endpoint.send(wide), connection.endpoint.send({ value: "x" })]
    io.release()
    connection.drain()
    await Promise.all(sends)
    expect(io.written).toEqual([frameBytes, large, frameBytes])
  })

  test("a lost peer settles every waiting send with the close reason", async () => {
    const io = heldSocket()
    const connection = await connectScriptedSocket<{ value: string }, { value: string }>({
      wire: io.wire, decode: decodeMessage, maxFrameBytes: 64, maxMessageBytes: 64, maxQueuedBytes: frameBytes,
    })
    const outcomes = Promise.allSettled([connection.endpoint.send({ value: "x" }), connection.endpoint.send({ value: "x" })])
    connection.lost()
    for (const outcome of await outcomes) {
      expect(outcome.status).toBe("rejected")
      if (outcome.status === "rejected") expect(String(outcome.reason)).toContain("internal process endpoint peer closed")
    }
  })

  test("a message over the ceiling fails only its own send and leaves the endpoint open", async () => {
    const io = heldSocket()
    io.release()
    const connection = await connectScriptedSocket<{ value: string }, { value: string }>({
      wire: io.wire, decode: decodeMessage, maxFrameBytes: 16, maxMessageBytes: 16, maxQueuedBytes: 64,
    })
    await expect(connection.endpoint.send({ value: "far too long for sixteen bytes" })).rejects.toThrow("exceeds 16 bytes")
    await connection.endpoint.send({ value: "ok" })
    expect(io.written).toHaveLength(1)
  })

  test("a message wider than the queue goes alone once the queue is empty", async () => {
    const io = heldSocket()
    io.release()
    const connection = await connectScriptedSocket<{ value: string }, { value: string }>({
      wire: io.wire, decode: decodeMessage, maxFrameBytes: 8, maxMessageBytes: 1024, maxQueuedBytes: 16,
    })
    await connection.endpoint.send({ value: "a message wider than the whole queue bound" })
    expect(io.written.length).toBeGreaterThan(1)
  })
})

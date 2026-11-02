import { describe, expect, test } from "bun:test"

import {
  createInternalProcessFrameDecoder,
  createSocketProcessEndpoint,
  createMessagePortProcessEndpoint,
  encodeInternalProcessFrames,
} from "../../../src/infra/internal-process-channel.js"

const decodeMessage = (value: unknown): { readonly value: string } | undefined => {
  if (typeof value !== "object" || value === null || !("value" in value) || typeof value.value !== "string") return undefined
  return { value: value.value }
}

describe("internal process channel framing", () => {
  test("decodes fragmented and coalesced length-prefixed MessagePack frames", () => {
    const received: { readonly value: string }[] = []
    const decoder = createInternalProcessFrameDecoder({ maxFrameBytes: 64, decode: decodeMessage, onMessage: (message) => received.push(message) })
    const [first] = encodeInternalProcessFrames({ value: "first" })
    const [second] = encodeInternalProcessFrames({ value: "second" })
    if (!first || !second) throw new Error("expected one frame per message")
    const joined = new Uint8Array(first.length + second.length)
    joined.set(first)
    joined.set(second, first.length)

    expect(decoder.push(joined.subarray(0, 2))).toBe(true)
    expect(decoder.push(joined.subarray(2, first.length + 3))).toBe(true)
    expect(decoder.push(joined.subarray(first.length + 3))).toBe(true)
    expect(received).toEqual([{ value: "first" }, { value: "second" }])
  })

  test("rejects oversize and malformed frames before delivery", () => {
    const delivered: unknown[] = []
    const oversize = createInternalProcessFrameDecoder({ maxFrameBytes: 4, decode: decodeMessage, onMessage: (message) => delivered.push(message) })
    expect(oversize.push(new Uint8Array([0, 0, 0, 6]))).toBe(false)

    const malformed = createInternalProcessFrameDecoder({ maxFrameBytes: 64, decode: decodeMessage, onMessage: (message) => delivered.push(message) })
    expect(malformed.push(encodeInternalProcessFrames({ wrong: true })[0]!)).toBe(false)
    expect(delivered).toEqual([])
  })

  test("splits a message larger than one frame and reassembles it in order", () => {
    const received: { readonly value: string }[] = []
    const decoder = createInternalProcessFrameDecoder({ maxFrameBytes: 8, decode: decodeMessage, onMessage: (message) => received.push(message) })
    const value = "a message far longer than eight bytes of frame"
    const frames = encodeInternalProcessFrames({ value }, 8)
    expect(frames.length).toBeGreaterThan(3)
    for (const frame of frames) expect(frame.byteLength).toBeLessThanOrEqual(4 + 1 + 8)
    for (const frame of frames) expect(decoder.push(frame)).toBe(true)
    expect(received).toEqual([{ value }])
  })

  test("bounds reassembly by the message ceiling, not the frame size", () => {
    const value = "a message far longer than eight bytes of frame"
    expect(() => encodeInternalProcessFrames({ value }, 8, 16)).toThrow("exceeds 16 bytes")
    const decoder = createInternalProcessFrameDecoder({ maxFrameBytes: 8, maxMessageBytes: 16, decode: decodeMessage, onMessage: () => {} })
    const frames = encodeInternalProcessFrames({ value }, 8)
    const outcomes = frames.map((frame) => decoder.push(frame))
    expect(outcomes.at(-1)).toBe(false)
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
  const frameBytes = encodeInternalProcessFrames({ value: "x" })[0]!.byteLength

  function heldSocket() {
    let held = true
    const written: number[] = []
    return {
      written,
      release() { held = false },
      socket: {
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
    const connection = createSocketProcessEndpoint<{ value: string }, { value: string }>({
      socket: io.socket, decode: decodeMessage, maxFrameBytes: 64, maxMessageBytes: 64, maxQueuedBytes: frameBytes * 2,
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
    const connection = createSocketProcessEndpoint<{ value: string }, { value: string }>({
      socket: io.socket, decode: decodeMessage, maxFrameBytes: 64, maxMessageBytes: 64, maxQueuedBytes: frameBytes * 3,
    })
    const wide = { value: "x".repeat(30) }
    const large = encodeInternalProcessFrames(wide)[0]!.byteLength
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
    const connection = createSocketProcessEndpoint<{ value: string }, { value: string }>({
      socket: io.socket, decode: decodeMessage, maxFrameBytes: 64, maxMessageBytes: 64, maxQueuedBytes: frameBytes,
    })
    const outcomes = Promise.allSettled([connection.endpoint.send({ value: "x" }), connection.endpoint.send({ value: "x" })])
    connection.lost("peer went away")
    for (const outcome of await outcomes) {
      expect(outcome.status).toBe("rejected")
      if (outcome.status === "rejected") expect(String(outcome.reason)).toContain("peer went away")
    }
  })

  test("a message over the ceiling fails only its own send and leaves the endpoint open", async () => {
    const io = heldSocket()
    io.release()
    const connection = createSocketProcessEndpoint<{ value: string }, { value: string }>({
      socket: io.socket, decode: decodeMessage, maxFrameBytes: 16, maxMessageBytes: 16, maxQueuedBytes: 64,
    })
    await expect(connection.endpoint.send({ value: "far too long for sixteen bytes" })).rejects.toThrow("exceeds 16 bytes")
    await connection.endpoint.send({ value: "ok" })
    expect(io.written).toHaveLength(1)
  })

  test("a message wider than the queue goes alone once the queue is empty", async () => {
    const io = heldSocket()
    io.release()
    const connection = createSocketProcessEndpoint<{ value: string }, { value: string }>({
      socket: io.socket, decode: decodeMessage, maxFrameBytes: 8, maxMessageBytes: 1024, maxQueuedBytes: 16,
    })
    await connection.endpoint.send({ value: "a message wider than the whole queue bound" })
    expect(io.written.length).toBeGreaterThan(1)
  })
})

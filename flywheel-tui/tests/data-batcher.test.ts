import { describe, it, expect, beforeEach } from "bun:test"
import { DataBatcher } from "../src/worker/data-batcher"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// DataBatcher
// ---------------------------------------------------------------------------

describe("DataBatcher", () => {
  it("flushes on time threshold", async () => {
    const flushed: string[] = []
    const batcher = new DataBatcher((data) => flushed.push(data), {
      flushMs: 30,
      maxBytes: 1_000_000,
    })

    batcher.push("hello")
    expect(flushed).toHaveLength(0) // not flushed yet

    await wait(50) // wait past the flush interval

    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toBe("hello")

    batcher.dispose()
  })

  it("flushes immediately on size threshold", () => {
    const flushed: string[] = []
    const batcher = new DataBatcher((data) => flushed.push(data), {
      flushMs: 10_000, // very long — should not trigger
      maxBytes: 10,
    })

    // Push data larger than the 10-byte threshold
    batcher.push("this is definitely more than 10 bytes")

    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toBe("this is definitely more than 10 bytes")

    batcher.dispose()
  })

  it("coalesces multiple pushes into a single flush", async () => {
    const flushed: string[] = []
    const batcher = new DataBatcher((data) => flushed.push(data), {
      flushMs: 50,
      maxBytes: 1_000_000,
    })

    batcher.push("a")
    batcher.push("b")
    batcher.push("c")

    expect(flushed).toHaveLength(0) // not flushed yet

    await wait(80)

    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toBe("abc")

    batcher.dispose()
  })

  it("dispose() flushes remaining data", () => {
    const flushed: string[] = []
    const batcher = new DataBatcher((data) => flushed.push(data), {
      flushMs: 10_000,
      maxBytes: 1_000_000,
    })

    batcher.push("pending data")
    expect(flushed).toHaveLength(0)

    batcher.dispose()

    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toBe("pending data")
  })

  it("dispose() is idempotent — double dispose does not double-flush", () => {
    const flushed: string[] = []
    const batcher = new DataBatcher((data) => flushed.push(data), {
      flushMs: 10_000,
      maxBytes: 1_000_000,
    })

    batcher.push("data")
    batcher.dispose()
    batcher.dispose()

    expect(flushed).toHaveLength(1)
  })

  it("push after dispose is a no-op", () => {
    const flushed: string[] = []
    const batcher = new DataBatcher((data) => flushed.push(data), {
      flushMs: 10_000,
      maxBytes: 1_000_000,
    })

    batcher.push("before")
    batcher.dispose()
    batcher.push("after") // should be ignored

    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toBe("before")
  })

  it("handles Buffer input", async () => {
    const flushed: string[] = []
    const batcher = new DataBatcher((data) => flushed.push(data), {
      flushMs: 30,
      maxBytes: 1_000_000,
    })

    batcher.push(Buffer.from("buffer data"))

    await wait(50)

    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toBe("buffer data")

    batcher.dispose()
  })

  it("pendingBytes tracks buffered content", () => {
    const batcher = new DataBatcher(() => {}, {
      flushMs: 10_000,
      maxBytes: 1_000_000,
    })

    expect(batcher.pendingBytes).toBe(0)

    batcher.push("hello") // 5 bytes
    expect(batcher.pendingBytes).toBe(5)

    batcher.push(" world") // 6 bytes
    expect(batcher.pendingBytes).toBe(11)

    batcher.dispose()
    expect(batcher.pendingBytes).toBe(0)
  })

  it("uses default options when none provided", async () => {
    const flushed: string[] = []
    const batcher = new DataBatcher((data) => flushed.push(data))

    batcher.push("test")

    // Default flushMs is 16, so wait a bit longer
    await wait(40)

    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toBe("test")

    batcher.dispose()
  })

  it("size flush resets the timer", async () => {
    const flushed: string[] = []
    const batcher = new DataBatcher((data) => flushed.push(data), {
      flushMs: 100,
      maxBytes: 10,
    })

    // First push triggers size flush immediately
    batcher.push("12345678901") // > 10 bytes
    expect(flushed).toHaveLength(1)

    // Second push should start a fresh timer, not flush from the old one
    batcher.push("small")
    expect(flushed).toHaveLength(1) // still just the size flush

    await wait(150)
    expect(flushed).toHaveLength(2)
    expect(flushed[1]).toBe("small")

    batcher.dispose()
  })

  it("empty flush is a no-op (no callback invoked)", () => {
    let callCount = 0
    const batcher = new DataBatcher(() => { callCount++ }, {
      flushMs: 10_000,
      maxBytes: 1_000_000,
    })

    // Dispose without pushing anything — should not invoke onFlush
    batcher.dispose()
    expect(callCount).toBe(0)
  })
})

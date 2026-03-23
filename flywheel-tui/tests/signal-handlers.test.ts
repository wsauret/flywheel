import { describe, it, expect, beforeEach } from "bun:test"
import {
  setupSignalHandlers,
  shutdownOnce,
  _resetForTesting,
} from "../src/utils/signal-handlers"
import { TransientErrorWindow } from "../src/utils/transient-error-window"

// ---------------------------------------------------------------------------
// shutdownOnce() idempotency
// ---------------------------------------------------------------------------

describe("shutdownOnce", () => {
  beforeEach(() => {
    _resetForTesting()
  })

  it("runs cleanup exactly once", async () => {
    let callCount = 0
    setupSignalHandlers(async () => {
      callCount++
    })

    await shutdownOnce()
    await shutdownOnce()
    await shutdownOnce()

    expect(callCount).toBe(1)
  })

  it("handles cleanup that throws", async () => {
    setupSignalHandlers(async () => {
      throw new Error("cleanup exploded")
    })

    // Should not throw — errors are caught and logged
    await shutdownOnce()
  })

  it("works when no cleanup function is set", async () => {
    // Don't call setupSignalHandlers — shutdownOnce should still work
    await shutdownOnce()
  })
})

// ---------------------------------------------------------------------------
// setupSignalHandlers idempotency
// ---------------------------------------------------------------------------

describe("setupSignalHandlers", () => {
  beforeEach(() => {
    _resetForTesting()
  })

  it("updates cleanup function on subsequent calls", async () => {
    let firstCalled = false
    let secondCalled = false

    setupSignalHandlers(async () => { firstCalled = true })
    setupSignalHandlers(async () => { secondCalled = true })

    await shutdownOnce()

    expect(firstCalled).toBe(false)
    expect(secondCalled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// TransientErrorWindow
// ---------------------------------------------------------------------------

describe("TransientErrorWindow", () => {
  it("survives errors up to threshold", () => {
    const window = new TransientErrorWindow({ maxErrors: 3, windowMs: 60_000 })

    expect(window.recordError()).toBe(true) // 1
    expect(window.recordError()).toBe(true) // 2
    expect(window.recordError()).toBe(true) // 3
  })

  it("threshold exceeded returns false", () => {
    const window = new TransientErrorWindow({ maxErrors: 3, windowMs: 60_000 })

    window.recordError() // 1
    window.recordError() // 2
    window.recordError() // 3
    expect(window.recordError()).toBe(false) // 4 — exceeds threshold
  })

  it("errors outside window are pruned", async () => {
    const window = new TransientErrorWindow({ maxErrors: 2, windowMs: 50 })

    window.recordError() // 1
    window.recordError() // 2

    // Wait for the window to expire
    await new Promise((r) => setTimeout(r, 60))

    // These should be within a fresh window
    expect(window.recordError()).toBe(true) // 1 (old ones pruned)
    expect(window.recordError()).toBe(true) // 2
  })

  it("count reflects current window", async () => {
    const window = new TransientErrorWindow({ maxErrors: 10, windowMs: 50 })

    window.recordError()
    window.recordError()
    window.recordError()
    expect(window.count).toBe(3)

    // Wait for expiry
    await new Promise((r) => setTimeout(r, 60))
    expect(window.count).toBe(0)
  })

  it("uses defaults when no options provided", () => {
    const window = new TransientErrorWindow()

    // Should allow at least 50 errors
    for (let i = 0; i < 50; i++) {
      expect(window.recordError()).toBe(true)
    }
    // 51st should exceed
    expect(window.recordError()).toBe(false)
  })
})

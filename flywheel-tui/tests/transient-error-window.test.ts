import { describe, it, expect } from "bun:test"
import { TransientErrorWindow } from "../src/utils/transient-error-window"

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

  it("returns false when threshold exceeded", () => {
    const window = new TransientErrorWindow({ maxErrors: 3, windowMs: 60_000 })

    window.recordError() // 1
    window.recordError() // 2
    window.recordError() // 3
    expect(window.recordError()).toBe(false) // 4 exceeds
  })

  it("prunes errors outside the time window", async () => {
    const window = new TransientErrorWindow({ maxErrors: 2, windowMs: 50 })

    window.recordError() // 1
    window.recordError() // 2

    // Wait for the window to expire
    await new Promise((r) => setTimeout(r, 60))

    // Old errors are pruned, so these are within a fresh window
    expect(window.recordError()).toBe(true) // 1
    expect(window.recordError()).toBe(true) // 2
  })

  it("count reflects current window only", async () => {
    const window = new TransientErrorWindow({ maxErrors: 10, windowMs: 50 })

    window.recordError()
    window.recordError()
    window.recordError()
    expect(window.count).toBe(3)

    // Wait for expiry
    await new Promise((r) => setTimeout(r, 60))
    expect(window.count).toBe(0)
  })

  it("uses defaults (maxErrors=50, windowMs=60000)", () => {
    const window = new TransientErrorWindow()

    for (let i = 0; i < 50; i++) {
      expect(window.recordError()).toBe(true)
    }
    // 51st exceeds the default threshold of 50
    expect(window.recordError()).toBe(false)
  })

  it("handles rapid-fire errors within threshold", () => {
    const window = new TransientErrorWindow({ maxErrors: 100, windowMs: 1000 })

    for (let i = 0; i < 100; i++) {
      expect(window.recordError()).toBe(true)
    }
    expect(window.count).toBe(100)
  })

  it("returns true at exact threshold and false one over", () => {
    const window = new TransientErrorWindow({ maxErrors: 1, windowMs: 60_000 })

    expect(window.recordError()).toBe(true)  // exactly at threshold
    expect(window.recordError()).toBe(false)  // one over
  })
})

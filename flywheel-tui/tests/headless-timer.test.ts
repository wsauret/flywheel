import { describe, expect, it } from "vitest"
import { createHeadlessTimer } from "../src/orchestration/headless/headless-timer"

describe("HeadlessTimer", () => {
  it("stop() is callable and does not throw", () => {
    const timer = createHeadlessTimer()
    expect(() => timer.stop()).not.toThrow()
  })

  it("stop() can be called multiple times without error", () => {
    const timer = createHeadlessTimer()
    expect(() => {
      timer.stop()
      timer.stop()
    }).not.toThrow()
  })
})

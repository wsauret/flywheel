import { describe, expect, test } from "bun:test"

import { computeBackoffMs } from "../../../src/infra/backoff.js"

const options = { baseMs: 250, maxMs: 120_000, factor: 2 }
describe("computeBackoffMs", () => {
  test("the exponential window doubles per attempt (random=1 samples the top of the window)", () => {
    const opts = { ...options, random: () => 1 }
    expect(computeBackoffMs(0, opts)).toBe(options.baseMs)
    expect(computeBackoffMs(1, opts)).toBe(options.baseMs * 2)
    expect(computeBackoffMs(2, opts)).toBe(options.baseMs * 4)
    expect(computeBackoffMs(3, opts)).toBe(options.baseMs * 8)
  })

  test("applies full jitter: random scales the exponential window down toward zero", () => {
    // attempt 2 window is base*4; full jitter at 0.5 picks half of it, at 0 picks none.
    expect(computeBackoffMs(2, { ...options, random: () => 0.5 })).toBe((options.baseMs * 4) * 0.5)
    expect(computeBackoffMs(2, { ...options, random: () => 0 })).toBe(0)
  })

  test("caps the exponential window at maxMs even for large attempts", () => {
    const opts = { ...options, random: () => 1 }
    expect(computeBackoffMs(100, opts)).toBe(options.maxMs)
    expect(computeBackoffMs(100, opts)).toBeLessThanOrEqual(options.maxMs)
  })


})

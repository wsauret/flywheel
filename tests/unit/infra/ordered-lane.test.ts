import { describe, expect, mock, test } from "bun:test"
import { createBackgroundLane, createOrderedLane } from "../../../src/infra/ordered-lane.js"

describe("createOrderedLane", () => {
  test("starts each task after the tasks queued before it, and a failure stops none of them", async () => {
    const lane = createOrderedLane()
    const observed: string[] = []
    const gate = Promise.withResolvers<void>()
    const first = lane.run(async () => { observed.push("first start"); await gate.promise; observed.push("first end"); throw new Error("first failed") })
    const second = lane.run(() => { observed.push("second"); return "second" })
    gate.resolve()

    await expect(first).rejects.toThrow("first failed")
    expect(await second).toBe("second")
    await lane.settled()
    expect(observed).toEqual(["first start", "first end", "second"])
  })

  test("calls onIdle once when the last queued task settles, so a keyed owner can evict the lane", async () => {
    const onIdle = mock(() => {})
    const lane = createOrderedLane(onIdle)
    const gate = Promise.withResolvers<void>()
    const first = lane.run(() => gate.promise)
    const second = lane.run(() => Promise.reject(new Error("second failed")))
    gate.resolve()
    await first
    await expect(second).rejects.toThrow("second failed")
    await lane.settled()
    await Promise.resolve()
    expect(onIdle).toHaveBeenCalledTimes(1)
  })
})

describe("createBackgroundLane", () => {
  test("records a failed background task with its label and keeps the lane open", async () => {
    const log = { debug: mock(() => {}), info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) }
    const lane = createBackgroundLane(log, "test-lane")
    lane.runInBackground("step", () => Promise.reject(new Error("step failed")))
    const after = lane.run(() => "after")

    expect(await after).toBe("after")
    await lane.settled()
    expect(log.warn).toHaveBeenCalledWith("test-lane step failed", expect.objectContaining({ error: "step failed" }))
  })
})

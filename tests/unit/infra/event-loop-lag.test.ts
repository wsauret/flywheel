import { describe, expect, spyOn, test } from "bun:test"
import { Log } from "../../../src/infra/log"
import * as loop from "../../../src/infra/event-loop-lag"
import { createEventProjection } from "../../../src/infra/event-projection"
import { asAsyncEventReadSurface } from "../../../src/infra/event-store-types"
import { inMemoryEventReader } from "../../helpers/in-memory-event-reader"
import { createProjectStateClient } from "../../../src/orchestration/app-service/project-state-client"
import { encodeProjectStateResponseFrame, type ProjectStateResponseFrame } from "../../../src/orchestration/app-service/project-state-protocol"

describe("loop probes", () => {
  test("late samples name the units that ran across the gap, summed per unit, and coalesce repeats", async () => {
    let now = 0
    const clock = spyOn(performance, "now").mockImplementation(() => now)
    const callbacks: { delay: number; run: () => void }[] = []
    // A real handle, already cleared, stands in for each manually delivered timer.
    const inert = setTimeout(() => {}, 0)
    clearTimeout(inert)
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(new Proxy(globalThis.setTimeout, {
      apply(_target, _receiver, [callback, delay]: Parameters<typeof setTimeout>) {
        callbacks.push({ delay: delay ?? 0, run: () => callback() })
        return inert
      },
    }))
    const warn = spyOn(Log.create({ service: "event-loop-lag" }), "warn").mockImplementation(() => {})
    const debug = spyOn(Log.create({ service: "event-loop-lag" }), "debug").mockImplementation(() => {})
    let unit: ReturnType<typeof spyOn<typeof loop, "probeLoopUnit">> | undefined
    let span: ReturnType<typeof spyOn<typeof loop, "trackLoopSpan">> | undefined
    try {
      const modulePath = "../../../src/infra/event-loop-lag.ts?stall-attribution-test"
      const { ensureEventLoopLagSampler, probeLoopUnit, trackLoopSpan }: typeof import("../../../src/infra/event-loop-lag") = await import(modulePath)
      unit = spyOn(loop, "probeLoopUnit").mockImplementation(probeLoopUnit)
      span = spyOn(loop, "trackLoopSpan").mockImplementation(trackLoopSpan)
      ensureEventLoopLagSampler({ warnOnStallMs: 50 })
      probeLoopUnit("store-subscriber", "before-gap", () => { now = 20 })
      const endEarly = trackLoopSpan("rpc", "early")
      const endExit = trackLoopSpan("worker-exit", "invocation")
      now = 30
      endEarly()
      now = 40
      const endOpen = trackLoopSpan("rpc", "dispatch")
      probeLoopUnit("store-subscriber", "blocking", () => { now = 200 })
      probeLoopUnit("bus-subscriber", "tail", () => { now = 210 })
      probeLoopUnit("store-subscriber", "blocking", () => { now = 215 })
      // A span that ends inside the late interval, before the sampler runs,
      // still names the stall; a span that ended before the gap does not.
      endExit()
      endExit()
      now = 225
      callbacks.shift()!.run()
      endOpen()
      expect(warn.mock.calls).toEqual([["event loop stalled", {
        lagMs: 175,
        recentSlowUnit: "bus-subscriber:tail 10ms",
        inflight: ["worker-exit:invocation+195ms", "rpc:dispatch+185ms"],
        gapUnits: [
          { unit: "store-subscriber:blocking", count: 2, overlapMs: 155 },
          { unit: "bus-subscriber:tail", count: 1, overlapMs: 10 },
        ],
      }]])
      const repeatWindow = callbacks.shift()!
      expect(repeatWindow.delay).toBe(60_000)
      now = 260
      let respond: ((frame: ProjectStateResponseFrame) => boolean) | undefined
      const state = createProjectStateClient({
        send() {},
        onResponse(listener) { respond = listener },
        onClose() {},
        onStored() { return () => {} },
        onSessionChange() { return () => {} },
        close() {},
      })
      const position = state.capturePosition()
      const projection = createEventProjection(asAsyncEventReadSurface(inMemoryEventReader([{
        id: "fact", position: 1, aggregateId: "session:s", seq: 0, type: "test", version: 1,
        timestamp: 0, actor: "test", sessionId: "s", payload: {},
      }])), {
        name: "session-placement",
        initialState: () => ({}),
        reduce: (value) => { now = 450; return value },
      })
      await projection.replay()
      respond!(encodeProjectStateResponseFrame({ id: 1, result: { kind: "position", position: 1 } }))
      await position
      await state.close()
      now = 460
      callbacks.shift()!.run()
      expect(warn.mock.calls).toHaveLength(1)
      expect(debug.mock.calls).toContainEqual(["event loop stall observed", expect.objectContaining({
        inflight: ["project-state:control:position.capture+190ms"],
        gapUnits: [{ unit: "projection-apply:session-placement", count: 1, overlapMs: 175 }],
      })])
      // A unit that only ran after work no probe covered did not cause the
      // stall, however often it is the first to run after one.
      now = 900
      probeLoopUnit("bus-subscriber", "after-gap", () => { now = 901 })
      callbacks.shift()!.run()
      now = 1400
      probeLoopUnit("bus-subscriber", "after-gap", () => { now = 1401 })
      callbacks.shift()!.run()
      repeatWindow.run()
      expect(warn.mock.calls[1]).toEqual(["event loop stalled again", expect.objectContaining({ count: 3, maxLagMs: 450, topUnit: "projection-apply:session-placement", unattributed: 2 })])
    } finally {
      unit?.mockRestore()
      span?.mockRestore()
      debug.mockRestore()
      warn.mockRestore()
      timers.mockRestore()
      clock.mockRestore()
    }
  })

  test("probeLoopUnit rethrows and does not swallow", async () => {
    const { probeLoopUnit } = await import("../../../src/infra/event-loop-lag")
    expect(() => probeLoopUnit("test", "throws", () => { throw new Error("boom") })).toThrow("boom")
  })

})

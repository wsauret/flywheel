import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { createRoot } from "solid-js"
import { DebugLog } from "../../../src/infra/debug-log.js"
import { emitToolResultAvailable } from "../../../src/orchestration/agent-runtime/emit.js"
import { createOutputSession } from "../../../src/orchestration/runner/output-session.js"
import {
  markToolResultMounted,
  probe,
  probeDrain,
  probeGauge,
  probeToolRenderPhase,
  renderProbeEnabled,
  renderProbeFrame,
  setRenderProbeEnabled,
} from "../../../src/infra/render-probe.js"
import { createOutputTranscriptCache } from "../../../src/tui/transcript-store/create-output-transcript-cache.js"
import { fakeRuntimeClient, flushRecovery, liveView, textBlock, toolEntry } from "../tui/hooks/_output-transcript-cache-fixtures.js"

function probePayloadField(payload: unknown, field: "phase" | "monotonicEpochMs"): string | number | undefined {
  if (typeof payload !== "object" || payload === null || !(field in payload)) return undefined
  const value = Object.fromEntries(Object.entries(payload))[field]
  return typeof value === "string" || typeof value === "number" ? value : undefined
}

describe("render-probe diagnostics", () => {
  afterEach(() => {
    setRenderProbeEnabled(false)
    mock.restore()
  })

  it("is a no-op when probing is disabled", () => {
    setRenderProbeEnabled(false)
    expect(renderProbeEnabled()).toBe(false)
    probe("output.flush.immediate")
    probe("output.gap")
    expect(probeDrain()).toEqual({ counters: {}, gauges: {} })
  })

  it("counts named probes and drain clears them when enabled", () => {
    setRenderProbeEnabled(true)
    probeDrain()
    probe("output-intake")
    probe("output-intake")
    probe("output.gap")
    expect(probeDrain()).toEqual({ counters: { "output-intake": 2, "output.gap": 1 }, gauges: {} })
    // Drain cleared the counters: a second drain is empty.
    expect(probeDrain()).toEqual({ counters: {}, gauges: {} })
  })

  it("keeps the latest gauge sample and omits unsampled gauges after drain", () => {
    setRenderProbeEnabled(true)
    probeDrain()
    probeGauge("output-queue-depth", 2)
    probeGauge("output-queue-depth", 7)
    expect(probeDrain()).toEqual({ counters: {}, gauges: { "output-queue-depth": 7 } })
    expect(probeDrain()).toEqual({ counters: {}, gauges: {} })
  })

  it("records correlated phases with a calibrated monotonic timestamp", () => {
    const record = spyOn(DebugLog, "record").mockImplementation(() => {})
    setRenderProbeEnabled(true)

    // Bracket with the probe's own clock: the monotonic epoch drifts from
    // Date.now() over a process's life, so a wall-clock bracket flakes.
    const before = performance.timeOrigin + performance.now()
    probeToolRenderPhase("tool-1", "availability")
    const after = performance.timeOrigin + performance.now()

    expect(record).toHaveBeenCalledTimes(1)
    const call = record.mock.calls[0]?.[0]
    expect(call?.type).toBe("render.tool_result.phase")
    expect(call?.payload).toEqual({
      toolUseId: "tool-1",
      phase: "availability",
      monotonicEpochMs: expect.any(Number),
    })
    const at = probePayloadField(call?.payload, "monotonicEpochMs")
    expect(typeof at).toBe("number")
    if (typeof at !== "number") throw new Error("expected a monotonic probe timestamp")
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(after)
  })

  it("records only mounted results on their first containing frame and drops off-viewport pending results", () => {
    const record = spyOn(DebugLog, "record").mockImplementation(() => {})
    setRenderProbeEnabled(true)

    probeToolRenderPhase("visible", "application")
    probeToolRenderPhase("off-viewport", "application")
    markToolResultMounted("visible")
    renderProbeFrame()
    markToolResultMounted("visible")
    markToolResultMounted("off-viewport")
    renderProbeFrame()

    const firstFrames = record.mock.calls
      .map(([entry]) => entry.payload)
      .filter((payload) => probePayloadField(payload, "phase") === "first-frame")
    expect(firstFrames).toHaveLength(1)
    expect(firstFrames[0]).toEqual({
      toolUseId: "visible",
      phase: "first-frame",
      monotonicEpochMs: expect.any(Number),
    })
  })

  it("correlates availability with the output sync that publishes the result", () => {
    const record = spyOn(DebugLog, "record").mockImplementation(() => {})
    setRenderProbeEnabled(true)
    const session = createOutputSession({ updateEntry: () => {}, executionCwd: "/workspace" })
    try {
      session.applyProjectionEvent({
        type: "tool-use",
        toolUseId: "tool-1",
        name: "read",
        input: { path: "example.ts" },
        timestamp: 1,
      })
      session.flush()
      emitToolResultAvailable(
        session.dispatchRuntimeEvent,
        "tool-1",
        [{ type: "text", text: "done" }],
        "ok",
      )

      const phases = record.mock.calls.map(([entry]) => probePayloadField(entry.payload, "phase"))
      expect(phases).toContain("availability")
      expect(phases).toContain("output-sync")
      expect(phases.indexOf("availability")).toBeLessThan(phases.indexOf("output-sync"))
    } finally {
      session.dispose()
    }
  })

  it("the live delta intake counts intake, queue depth, pending bytes, flush reason, and applies", async () => {
    const record = spyOn(DebugLog, "record").mockImplementation(() => {})
    setRenderProbeEnabled(true)
    probeDrain()
    await createRoot(async (dispose) => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000 })
      cache.retain("chat-1")
      await fake.live(cache, "chat-1", liveView([toolEntry("tool-1")]))
      const { counters, gauges } = probeDrain()
      expect(counters["output-intake"]).toBeGreaterThan(0)
      expect(gauges["output-queue-depth"]).toBe(0)
      expect(counters["output.flush.immediate"]).toBeGreaterThan(0)
      expect(counters["output-applied"]).toBeGreaterThan(0)
      const phases = record.mock.calls.map(([entry]) => probePayloadField(entry.payload, "phase"))
      expect(phases).toContain("intake")
      expect(phases).toContain("application")
      dispose()
    })
  })

  it("the transcript cache counts a recovery request and the recovery that answers it", async () => {
    setRenderProbeEnabled(true)
    probeDrain()
    await createRoot(async (dispose) => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000 })
      fake.setOutputWindow("chat-1", [textBlock("a", "authoritative")])
      await cache.open("chat-1")
      fake.invalidate("chat-1", "overflow")
      await flushRecovery()
      const { counters } = probeDrain()
      expect(counters["output.recovery.request"]).toBeGreaterThan(0)
      expect(counters["output.recovery"]).toBeGreaterThan(0)
      dispose()
    })
  })
})

import { describe, expect, test } from "bun:test"
import { analyzeBurst } from "../../release/scenarios/scroll.js"
import type { DebugLogRecord } from "../../release/lib/debug-log-reader.js"
import type { MetricValues } from "../../release/lib/metrics.js"
import { probeViewport, type ScrollObservation, type TerminalChunk } from "../../release/lib/scroll-terminal.js"
import { assertBudgets, parseBudgets } from "../../release/lib/metrics.js"
import rawBudgets from "../../release/budgets.json"
import { GIANT_SESSION_ID } from "../../release/fixtures/generate-store.js"

const budgets = parseBudgets(rawBudgets)

const pageObservation: ScrollObservation = {
  mode: "pageKeys", inputs: [2100, 2200], viewport: { top: 4, bottom: 31, right: 149 },
  probes: [{ input: 2100, response: 2110 }, { input: 2200, response: 2210 }], directions: [],
  chunks: [
    { ts: 2110, text: "\u001b[?2026h\u001b[10;6Hfirst viewport\u001b[?2026l" },
    { ts: 2210, text: "\u001b[?2026h\u001b[10;6Hsecond viewport\u001b[?2026l" },
  ],
}

describe("release scroll diagnostics", () => {
  test.each([
    { type: "render.frame.summary", payload: { renderer: { frameTimes: [5, 10, 120] } } },
    { type: "log.info", payload: { service: "render-probe", message: "render diagnostics", renderer: { frameTimes: [5, 10, 120] } } },
  ])("measures $type render samples", (sample) => {
    const records: DebugLogRecord[] = [
      { ts: 2000, ...sample },
      { ts: 2000, type: "log.debug", payload: { service: "output-window-scroll", message: "scroll position changed", scrollTop: 10 } },
    ]
    const metrics: MetricValues = {}
    const failures: string[] = []
    analyzeBurst(records, 2000, 3000, metrics, failures, pageObservation)
    expect(failures).toEqual([])
    expect(metrics["scroll.pageKeys.rendererP95Ms"]).toBe(120)
    expect(metrics["scroll.maxFrameMs"]).toBe(0)
    expect(metrics["scroll.stallCount"]).toBe(0)
  })

  test("rejects missing viewport samples and scroll engagement", () => {
    const failures: string[] = []
    analyzeBurst([], 2000, 3000, {}, failures, { ...pageObservation, chunks: [], probes: [] })
    expect(failures).toContain("scroll.pageKeys: no input reached changed viewport output")
    expect(failures).toContain("scroll.pageKeys: no scroll-position changes in the active window; the burst did not engage the scroll pipeline")
  })

  test("excludes diagnostics and terminal output outside the active interaction", () => {
    const records: DebugLogRecord[] = [
      { ts: 1500, type: "render.frame.summary", payload: { renderer: { frameTimes: [900] } } },
      { ts: 2200, type: "render.frame.summary", payload: { renderer: { frameTimes: [8] } } },
      { ts: 3100, type: "render.frame.summary", payload: { renderer: { frameTimes: [800] } } },
      { ts: 2200, type: "log.debug", payload: { service: "output-window-scroll", message: "scroll position changed", scrollTop: 10 } },
    ]
    const metrics: MetricValues = {}
    const frame = (start: number, end: number) => [
      { ts: start, text: "\u001b[?2026h\u001b[10;6Hchanged transcript" },
      { ts: end, text: "\u001b[?2026l" },
    ]
    analyzeBurst(records, 2000, 3000, metrics, [], {
      mode: "wheel", inputs: [1990, 2100, 2200, 3010],
      probes: [{ input: 2100, response: 2115 }, { input: 2200, response: 2220 }], directions: [],
      chunks: [
        ...frame(1800, 1999),
        { ts: 1999, text: "\u001b[?202" },
        { ts: 2001, text: "6h\u001b[10;6Hopening frame\u001b[?2026l" },
        ...frame(2110, 2115), ...frame(2210, 2220), ...frame(2990, 3010),
      ],
      viewport: { top: 4, bottom: 31, right: 149 },
    })
    expect(metrics["scroll.wheel.p95InputToOutputMs"]).toBe(20)
    expect(metrics["scroll.wheel.p95FrameGapMs"]).toBe(105)
    expect(metrics["scroll.wheel.frames"]).toBe(2)
    expect(metrics["scroll.wheel.inputs"]).toBe(2)
    expect(metrics["scroll.wheel.rendererP95Ms"]).toBe(8)
  })

  test("an added output delay increases input-to-output latency, not unrelated chrome", async () => {
    const measure = async (delay: number) => {
      const metrics: MetricValues = {}
      const chunks: TerminalChunk[] = []
      let clock = 2100
      const probe = await probeViewport({
        chunks, send: () => clock, capture: async () => clock >= 2110 + delay ? "new transcript" : "old transcript",
        clock: () => clock,
        async pause() {
          clock++
          if (clock === 2101) chunks.push({ ts: clock, text: "\u001b[?2026h\u001b[39;6Hspinner\u001b[?2026l" })
          if (clock === 2110 + delay) chunks.push({ ts: clock, text: "\u001b[?2026h\u001b[10;6Hnew transcript\u001b[?2026l" })
        },
      }, pageObservation.viewport)
      analyzeBurst([], 2000, 3000, metrics, [], {
        mode: "drag", inputs: [2100], probes: [probe], directions: [], chunks,
        viewport: { top: 4, bottom: 31, right: 149 },
      })
      return metrics["scroll.drag.p95InputToOutputMs"]
    }
    expect(await measure(0)).toBe(10)
    expect(await measure(40)).toBe(50)
  })

  test.each([
    { delay: 50, violations: 0, duringCapture: false },
    { delay: 78, violations: 0, duringCapture: false },
    { delay: 138, violations: 1, duringCapture: false },
    { delay: 138, violations: 1, duringCapture: true },
  ])("does not alias $delay ms responses when a frame starts during capture: $duringCapture", async ({ delay, violations, duringCapture }) => {
    const inputs = Array.from({ length: 60 }, (_, i) => 2100 + i * 60)
    const metrics: MetricValues = {}
    const chunks: TerminalChunk[] = []
    let clock = 7000
    const probe = await probeViewport({
      chunks, send: () => clock, clock: () => clock,
      // The old frame can repaint unchanged text. Only the response changes the expected viewport.
      async capture() {
        if (duringCapture && clock === 7018) {
          clock = 7000 + delay - 1
          chunks.push({ ts: clock, text: "\u001b[?2026h\u001b[10;6Hexpected scrolled transcript" })
        }
        return clock >= 7000 + delay - 1 ? "expected scrolled transcript" : "previous viewport"
      },
      async pause() {
        clock++
        if (clock === 7018) chunks.push({ ts: clock, text: "\u001b[?2026h\u001b[10;6Hprevious viewport\u001b[?2026l" })
        if (!duringCapture && clock === 7000 + delay - 1) chunks.push({ ts: clock, text: "\u001b[?2026h\u001b[10;6Hexpected scrolled transcript" })
        if (clock === 7000 + delay) chunks.push({ ts: clock, text: "\u001b[?2026l" })
      },
    }, pageObservation.viewport)
    analyzeBurst([], 2000, 6000, metrics, [], {
      mode: "drag", inputs,
      chunks: inputs.map(ts => ({ ts: ts + delay, text: "\u001b[?2026h\u001b[10;6Hchanged transcript\u001b[?2026l" })),
      viewport: pageObservation.viewport,
      probes: [probe],
      directions: [],
    })
    expect(metrics["scroll.drag.p95InputToOutputMs"]).toBe(delay)
    expect(assertBudgets(metrics, budgets)).toHaveLength(violations)
  })

  test("includes a silent tail and each direction in the response gap", () => {
    const metrics: MetricValues = {}
    analyzeBurst([], 2100, 5800, metrics, [], {
      mode: "drag", inputs: Array.from({ length: 60 }, (_, i) => 2100 + i * 60),
      chunks: [
        { ts: 2120, text: "\u001b[?2026h\u001b[10;6Hfirst\u001b[?2026l" },
        { ts: 2180, text: "\u001b[?2026h\u001b[10;6Hsecond\u001b[?2026l" },
      ],
      viewport: pageObservation.viewport,
      directions: [{ start: 2100, end: 3900, direction: "up" }, { start: 3900, end: 5800, direction: "down" }],
      probes: [{ input: 6000, response: 6020 }],
    })
    expect(metrics["scroll.drag.maxResponseGapMs"]).toBe(1900)
    expect(assertBudgets(metrics, budgets)).toContainEqual({
      metric: "scroll.drag.maxResponseGapMs", measured: 1900, limit: 165, kind: "ceiling",
    })
  })

  test("exempts only a direction whose global boundary was observed", () => {
    const observe = (boundary: { hasBefore?: boolean; scrollTop?: number }, includeDown = false, presentation = 2210) => {
      const metrics: MetricValues = {}
      analyzeBurst([{
        ts: 2200, type: "log.debug",
        payload: { service: "output-window-scroll", message: "scroll position changed", ...boundary },
      }], 2100, 5800, metrics, [], {
        ...pageObservation, mode: "drag",
        chunks: [pageObservation.chunks[0]!, ...(presentation ? [{
          ts: presentation, text: "\u001b[?2026h\u001b[10;6Hboundary viewport\u001b[?2026l",
        }] : [])],
        directions: [{ start: 2100, end: 3900, direction: "up" }, ...(includeDown ? [{ start: 3900, end: 5800, direction: "down" as const }] : [])],
      })
      return metrics["scroll.drag.maxResponseGapMs"]
    }
    expect(observe({ scrollTop: 0 })).toBe(1690)
    expect(observe({ hasBefore: false, scrollTop: 0 })).toBe(100)
    expect(observe({ hasBefore: false, scrollTop: 0 }, false, 0)).toBe(1790)
    const delayed = observe({ hasBefore: false, scrollTop: 0 }, false, 2500)!
    expect(delayed).toBe(390)
    expect(assertBudgets({ "scroll.drag.maxResponseGapMs": delayed }, budgets)).toContainEqual({
      metric: "scroll.drag.maxResponseGapMs", measured: 390, limit: 165, kind: "ceiling",
    })
    // Reaching the head cannot exempt the unanswered downward direction.
    expect(observe({ hasBefore: false, scrollTop: 0 }, true)).toBe(1900)
  })

  test("requires application text receipt inside the growing burst, not server enqueues", () => {
    const observe = (receivedAt?: number) => {
      const failures: string[] = []
      const metrics: MetricValues = { "scroll.growing.appendedDeltas": 17 }
      analyzeBurst([
        { ts: 2200, type: "log.debug", payload: { service: "output-window-scroll", message: "scroll position changed", scrollTop: 10 } },
        ...(receivedAt === undefined ? [] : [{
          ts: receivedAt, type: "model.stream.event_observed", sessionId: GIANT_SESSION_ID,
          payload: { source: "normalized", kind: "text_delta", metadata: { text: { chars: 120 } } },
        }]),
      ], 2000, 3000, metrics, failures, { ...pageObservation, mode: "growing" })
      return { metrics, failures }
    }
    const missing = "scroll.growing: no application text receipt during the continuous burst"
    expect(observe().failures).toContain(missing)
    expect(observe(3001).failures).toContain(missing)
    expect(observe(2200).failures).toEqual([])
    expect(observe(2200).metrics["scroll.growing.receivedTextSamples"]).toBe(1)
  })
})

/** @jsxImportSource @opentui/solid */
import { expect, it } from "bun:test"
import { TextRenderable, type Renderable } from "@opentui/core"
import { runtimeDispatch, runtimeQuery } from "../../../../helpers/runtime-dispatch.js"
import type { UsageSessionStats } from "../../../../../src/protocol/modules/subscription-usage.js"
const [{ testRender }, { createComponent }, { ThemeProvider }, { createStatsSurface }, { createModalStack }] = await Promise.all([
  import("@opentui/solid"), import("solid-js/web"), import("../../../../../src/tui/context/theme.js"),
  import("../../../../../src/tui/modules/subscription-usage/stats-surface.js"), import("../../../../../src/tui/components/modal-stack.js"),
])

it("keeps long model labels, rates, missing measurements and coverage readable at 80 columns", async () => {
  const summary = { attempts: 3, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true, tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 150 }, estimatedBilledUsd: 0.25, includedValueUsd: 0, priceUnavailable: false }
  const measured = { outputTokens: 100, durationMs: 5000, measuredRequests: 2, unmeasuredRequests: 1, measuredBlocks: 2, excludedBlocks: 1, averageTokensPerSecond: 20 }
  const model = "a-long-comparison-model-name-with-readable-suffix"
  let stats: UsageSessionStats = {
    sessionId: "session-a", asOf: 1, partial: true, descendantCount: 1,
    direct: summary, descendants: summary, totals: { ...summary, unmeasuredAttempts: 2, partialAttempts: 1, cacheComplete: false }, models: [{ ...summary, model: "measured-model" }], tools: [{ name: "read", calls: 1, errors: 0, blocked: 0, cancelled: 0, interrupted: 0, stopped: 0 }],
    generation: { basis: "O200kBase", totals: measured, coverageComplete: false, models: [
      { ...measured, model, reasoningEffort: "high" },
      { ...measured, model: "unmeasured-model", reasoningEffort: "medium", averageTokensPerSecond: null },
    ] },
  }
  const query = runtimeQuery({ "usage.stats": async () => stats })
  const modal = createModalStack()
  function Surface() {
    createStatsSurface({
      modal, client: { query, dispatch: runtimeDispatch({}) },
      foregroundId: () => "session-a", auth: () => undefined, projectRoot: () => "/scratch", appVersion: "0.0.0-test", enabled: () => true,
      read: () => undefined, clipboard: { copy: async () => {} }, navigate: { openSettings: async () => {}, openSurface: () => {}, navigateSession: () => {} }, showToast: () => {},
    })()
    const entry = modal.stack[0]
    if (!entry) throw new Error("Stats did not open")
    return typeof entry.element === "function" ? entry.element() : entry.element
  }
  const rendered = await testRender(() => createComponent(ThemeProvider, {
    mode: "dark", get children() { return createComponent(Surface, {}) },
  }), { width: 80, height: 60 })
  try {
    await rendered.renderOnce()
    await Promise.resolve()
    await rendered.renderOnce()
    const frame = rendered.captureCharFrame()
    const lines = frame.split("\n")
    const labelLine = lines.findIndex((line) => line.includes(`${model} · high`))
    expect(labelLine).toBeGreaterThanOrEqual(0)
    expect(lines[labelLine + 1]).toContain("20.0 avg tok/s")
    const unmeasuredLine = lines.findIndex((line) => line.includes("unmeasured-model · medium"))
    expect(unmeasuredLine).toBeGreaterThanOrEqual(0)
    expect(lines[unmeasuredLine + 1]).toContain("Not measured")
    expect(frame).toContain("This session, including descendant work")
    const readable = lines.map((line) => line.replace(/[│┃]/g, "").trim()).join(" ")
    expect(readable).toContain("2 measured requests · 1 known unmeasured requests · 1 excluded")
    expect(readable).toContain("output blocks")
    expect(readable).toContain("Historical request coverage can be unknown.")
    expect(readable).toContain("O200kBase local comparison tokens.")
    // Totals: coverage beside the measured count, and unreported cache reads never read as zero.
    expect(readable).toContain("3 measured requests (1 partial) · 2 unmeasured")
    expect(readable).toContain("Reported cache hit rate  Unavailable (not reported for every request)")
    expect(readable).toContain("Cached Unavailable · Uncached Unavailable")
    expect(readable).toContain("Not billed provider tokens.")
    modal.stack[0]?.onKey?.({ name: "m" })
    modal.stack[0]?.onKey?.({ name: "t" })
    await rendered.renderOnce()
    const descendants = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(descendants)]
    const held = descendants(rendered.renderer.root).filter(node => node instanceof TextRenderable && /measured-model|read  |avg tok/.test(node.plainText))
    expect(held.length).toBeGreaterThan(2)
    stats = { ...structuredClone(stats), tools: stats.tools.map(tool => ({ ...tool, calls: 7 })), generation: { ...stats.generation, models: stats.generation.models.map(row => ({ ...row, averageTokensPerSecond: 30 })) } }
    modal.stack[0]?.onKey?.({ name: "r" })
    await Promise.resolve()
    await rendered.renderOnce()
    expect(held.every(node => descendants(rendered.renderer.root).includes(node))).toBe(true)
    expect(rendered.captureCharFrame()).toContain("7 calls")
    expect(rendered.captureCharFrame()).toContain("30.0 avg tok/s")
  } finally {
    modal.clear()
    rendered.renderer.destroy()
  }
})

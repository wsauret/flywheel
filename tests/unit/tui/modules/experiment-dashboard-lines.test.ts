import { describe, expect, it } from "bun:test"
import type { RGBA } from "@opentui/core"
import type { FrontendExperimentRun, FrontendExperimentView } from "../../../../src/protocol/modules/experiments.js"
import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"
import { BASELINE_PENDING_COPY, CONFIDENCE_PENDING_COPY, NO_RUNS_COPY, renderDashboardLines, type DashboardLine } from "../../../../src/tui/modules/experiments/dashboard-lines.js"
import { chunkDisplayWidth } from "../../../../src/tui/output-blocks/tool-row-wrap.js"

const theme = resolveTheme(flywheelTheme, "dark")

function run(overrides: Partial<FrontendExperimentRun> & { run: number }): FrontendExperimentRun {
  return { segment: 1, commit: "abc1234", metric: 100, metrics: {}, status: "keep", description: `run ${overrides.run}`, confidence: null, durationMs: 1000, ...overrides }
}

function view(overrides: Partial<FrontendExperimentView> = {}): FrontendExperimentView {
  const runs = overrides.runs ?? []
  const current = runs.filter((r) => r.segment === (overrides.segment ?? 1))
  return {
    name: "speedup",
    metric: { name: "time", unit: "ms" },
    secondaryMetrics: [],
    direction: "lower",
    segment: 1,
    baseline: current[0]?.metric ?? null,
    best: null,
    confidence: null,
    runCounts: {
      total: current.length,
      kept: current.filter((r) => r.status === "keep").length,
      discarded: current.filter((r) => r.status === "discard").length,
      crashed: current.filter((r) => r.status === "crash").length,
      checksFailed: current.filter((r) => r.status === "checks_failed").length,
    },
    active: true,
    running: false,
    ...overrides,
    runs,
  }
}

const text = (line: DashboardLine): string => line.map((chunk) => chunk.text).join("")
const lineWith = (lines: DashboardLine[], needle: string): DashboardLine => {
  const found = lines.find((line) => text(line).includes(needle))
  if (!found) throw new Error(`no line contains ${JSON.stringify(needle)}: ${lines.map(text).join("\n")}`)
  return found
}
const colorOf = (line: DashboardLine, needle: string): RGBA => {
  const chunk = line.find((candidate) => candidate.text.includes(needle))
  if (!chunk?.fg) throw new Error(`no colored chunk contains ${JSON.stringify(needle)} in ${JSON.stringify(text(line))}`)
  return chunk.fg
}

const history = [
  run({ run: 1, segment: 0, metric: 250, status: "keep", commit: "0000000", description: "old baseline" }),
  run({ run: 2, segment: 1, metric: 200, status: "keep", commit: "aaaaaaa", description: "baseline" }),
  run({ run: 3, segment: 1, metric: 180, status: "keep", commit: "bbbbbbb", description: "faster loop" }),
  run({ run: 4, segment: 1, metric: 240, status: "discard", commit: "", description: "slower" }),
  run({ run: 5, segment: 1, metric: 0, status: "crash", commit: "", description: "exploded" }),
]

describe("renderDashboardLines", () => {
  it("renders the empty state when there are no runs", () => {
    const lines = renderDashboardLines(view(), 80, theme)
    expect(lines.map(text)).toEqual([`  ${NO_RUNS_COPY}`])
  })

  it("preserves column order and kept-commit display for current and old rows", () => {
    const lines = renderDashboardLines(view({ runs: history, confidence: 2.4 }), 100, theme)
    const rendered = lines.map(text)

    // Runs counts every segment; kept/discarded/crashed count the current one.
    expect(rendered[0]).toBe("  Runs: 5  2 kept  (conf: 2.4×)  1 discarded  1 crashed")
    expect(rendered[1]).toBe("  Baseline: ★ time: 200ms #2")
    expect(rendered[2]).toBe("  Progress: ★ time: 180ms #3 (-10.0%)")
    expect(rendered[3]).toBe("")
    expect(rendered[4]).toMatch(/^ {2}# {2}commit {2}★ time {5}status {9}description$/)
    expect(rendered[5]).toBe(`  ${"─".repeat(96)}`)

    const oldRow = lineWith(lines, "(old)")
    expect(text(oldRow)).toMatch(/^ {2}1 {2}\(old\) {3}250ms {6}keep {11}old baseline$/)
    expect(colorOf(oldRow, "(old)").equals(theme.textSubtle)).toBe(true)
    expect(colorOf(oldRow, "250ms").equals(theme.textSubtle)).toBe(true)
    expect(colorOf(oldRow, "keep").equals(theme.textSubtle)).toBe(true)

    const keptRow = lineWith(lines, "bbbbbbb")
    expect(colorOf(keptRow, "bbbbbbb").equals(theme.accent)).toBe(true)
    expect(colorOf(keptRow, "180ms").equals(theme.success)).toBe(true)
    expect(colorOf(keptRow, "keep").equals(theme.success)).toBe(true)

    const baselineRow = lineWith(lines, "aaaaaaa")
    expect(colorOf(baselineRow, "200ms").equals(theme.text)).toBe(true)

    const discardRow = lineWith(lines, "slower")
    expect(text(discardRow)).toContain("    —   ")
    expect(colorOf(discardRow, "discard").equals(theme.warning)).toBe(true)
    expect(colorOf(lineWith(lines, "exploded"), "crash").equals(theme.error)).toBe(true)
  })

  it("bands confidence at 2.0 and 1.0 and names pending values explicitly", () => {
    const at = (confidence: number | null) => renderDashboardLines(view({ runs: history, confidence }), 100, theme)[0]!
    expect(colorOf(at(2.0), "conf:").equals(theme.success)).toBe(true)
    expect(colorOf(at(1.9), "conf:").equals(theme.warning)).toBe(true)
    expect(colorOf(at(0.9), "conf:").equals(theme.error)).toBe(true)
    expect(text(at(null))).toContain(`(${CONFIDENCE_PENDING_COPY})`)

    const pendingBaseline = renderDashboardLines(view({ runs: [run({ run: 1, segment: 0 })], baseline: null }), 100, theme)
    expect(text(lineWith(pendingBaseline, "Baseline:"))).toBe(`  Baseline: ${BASELINE_PENDING_COPY}`)
  })

  it("drops secondary columns from the right when the width is narrow", () => {
    const secondaryMetrics = [{ name: "mem", unit: "MB" }, { name: "cpu", unit: "%" }, { name: "io", unit: "" }]
    const runs = history.map((r) => ({ ...r, metrics: { mem: 512, cpu: 40, io: 7 } }))
    const wide = renderDashboardLines(view({ runs, secondaryMetrics }), 140, theme).map(text)
    const narrow = renderDashboardLines(view({ runs, secondaryMetrics }), 72, theme).map(text)

    const wideHeader = wide.find((line) => line.includes("commit"))!
    const narrowHeader = narrow.find((line) => line.includes("commit"))!
    expect(wideHeader).toMatch(/commit .*★ time.*mem .*cpu .*io .*status .*description/)
    expect(narrowHeader).toContain("mem")
    expect(narrowHeader).toContain("cpu")
    expect(narrowHeader).not.toContain("io ")
    expect(narrowHeader.indexOf("status")).toBeGreaterThan(narrowHeader.indexOf("mem"))
    expect(wide.some((line) => line.includes("mem: 512MB"))).toBe(true)
  })

  it("windows to the newest rows and fits every line within the width", () => {
    const runs = Array.from({ length: 9 }, (_, i) => run({ run: i + 1, metric: 200 - i, commit: `c${i}`.padEnd(7, "0"), description: "a very long description that will be clipped ".repeat(3) }))
    for (const width of [48, 72, 120]) {
      const lines = renderDashboardLines(view({ runs }), width, theme, 3)
      expect(text(lineWith(lines, "earlier run"))).toBe("  … 6 earlier runs")
      expect(lines.filter((line) => /^ {2}\d/.test(text(line))).map(text).map((line) => line.trim().split(/\s+/)[0])).toEqual(["7", "8", "9"])
      for (const line of lines) expect(chunkDisplayWidth(line)).toBeLessThanOrEqual(width)
    }
    expect(renderDashboardLines(view({ runs }), 120, theme, 0).filter((line) => /^ {2}\d/.test(text(line)))).toHaveLength(9)
  })
})

import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { importBuiltModule } from "../../test-support/import-built-module.js"
import { loadSolidFixture } from "../../test-support/solid-transform.js"

import type { FrontendExperimentRun, FrontendExperimentView } from "../../../../src/protocol/modules/experiments.js"
import { confidenceBand, formatMetric } from "./strip.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("strip-fixture.ts", import.meta.url))],
  target: "bun",
  conditions: ["browser"],
  format: "esm",
  plugins: [{
    name: "reactive-solid-with-memory-host",
    setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
      builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
    },
  }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const javascript = build.outputs.find((output) => output.kind === "entry-point")
if (!javascript) throw new Error("Reactive fixture build produced no JavaScript")
const { mountExperimentStrip }: typeof import("./strip-fixture.js") =
  await importBuiltModule(javascript)

const microtask = () => new Promise<void>((resolve) => { queueMicrotask(resolve) })

function run(overrides: Partial<FrontendExperimentRun> & { readonly run: number }): FrontendExperimentRun {
  return { segment: 1, commit: `c${overrides.run}`, metric: 10, metrics: {}, status: "keep", description: `attempt ${overrides.run}`, confidence: null, durationMs: 1500, ...overrides }
}

function view(overrides: Partial<FrontendExperimentView> = {}): FrontendExperimentView {
  const runs = overrides.runs ?? [run({ run: 1, metric: 12, status: "keep" }), run({ run: 2, metric: 13.5, status: "discard", confidence: 0.4 })]
  return {
    name: "Tokenizer speed",
    metric: { name: "latency", unit: "ms" },
    secondaryMetrics: [{ name: "memory", unit: "MB" }],
    direction: "lower",
    segment: 1,
    baseline: 12,
    best: 12,
    confidence: 2.4,
    runCounts: { total: runs.length, kept: 1, discarded: 1, crashed: 0, checksFailed: 0 },
    runs,
    active: true,
    running: false,
    ...overrides,
  }
}

describe("experiment strip", () => {
  test("collapsed, it is one summary line: name, best, baseline, tally, confidence band", () => {
    const mounted = mountExperimentStrip(view())
    const text = mounted.text()
    assert.match(text, /Tokenizer speed/)
    assert.match(text, /best12 ms/)
    assert.match(text, /baseline12 ms/)
    assert.match(text, /2 runs · 1 kept/)
    assert.match(text, /2\.4x/)
    assert.match(text, /active/)
    assert.equal(mounted.find("experiment-confidence")[0]?.properties.class, "experiment-confidence band-success")
    assert.equal(mounted.find("experiment-runs").length, 0, "the table stays closed until asked")
    mounted.dispose()
  })

  test("pending figures are said, not left blank, before the first measurement", () => {
    const mounted = mountExperimentStrip(view({ baseline: null, best: null, confidence: null, runs: [], runCounts: { total: 0, kept: 0, discarded: 0, crashed: 0, checksFailed: 0 } }))
    assert.match(mounted.text(), /bestpending/)
    assert.match(mounted.text(), /baselinepending/)
    assert.match(mounted.text(), /0 runs/)
    assert.equal(mounted.find("experiment-confidence").length, 0)
    mounted.showDashboard()
    assert.match(mounted.text(), /No runs recorded yet/)
    mounted.dispose()
  })

  test("the dashboard request opens the table, newest first, and puts focus on it", async () => {
    const mounted = mountExperimentStrip(view())
    mounted.showDashboard()
    await microtask()
    assert.equal(mounted.focused(), "experiment-runs")
    assert.equal(mounted.find("disclosure")[0]?.properties["aria-expanded"], true)
    const rows = mounted.find("experiment-run")
    assert.equal(rows.length, 2)
    assert.match(mounted.text(), /#2.*#1/s, "newest run leads")
    assert.equal(rows[0]?.properties.class, "experiment-run status-discard")
    assert.match(mounted.text(), /discarded13\.5 ms/)
    assert.match(mounted.text(), /attempt 2/)
    assert.match(mounted.text(), /1\.5s/)
    assert.equal(mounted.find("experiment-confidence").at(-1)?.properties.class, "experiment-confidence band-error")
    mounted.setView(structuredClone(view()))
    assert.equal(mounted.find("experiment-run")[0], rows[0])
    mounted.setView(view({ runs: [run({ run: 1 }), run({ run: 2, metric: 14 }), run({ run: 3 })] }))
    assert.equal(mounted.find("experiment-run")[1], rows[0])
    assert.equal(mounted.find("disclosure")[0]?.properties["aria-expanded"], true)
    assert.match(mounted.text(), /#3.*#2.*14 ms.*#1/s)
    mounted.dispose()
  })

  test("a run in flight shows a pending placeholder row and the busy state, and the update follows the frame", () => {
    const mounted = mountExperimentStrip(view({ running: true }))
    assert.match(mounted.text(), /measuring/)
    assert.equal(mounted.find("experiment-busy").length, 1)
    mounted.showDashboard()
    const pending = mounted.find("pending")
    assert.equal(pending[0]?.properties["aria-busy"], "true")
    assert.match(mounted.text(), /#3measuringpending/)
    mounted.setView(view({ running: false, runs: [run({ run: 1 }), run({ run: 2 }), run({ run: 3, metric: 9, confidence: 1.2 })] }))
    assert.equal(mounted.find("pending").length, 0)
    assert.equal(mounted.find("experiment-busy").length, 0)
    assert.equal(mounted.find("experiment-run").length, 3)
    mounted.dispose()
  })

  test("rows from an earlier segment are marked as history and secondary metrics render per row", () => {
    const mounted = mountExperimentStrip(view({ segment: 2, runs: [run({ run: 1, segment: 1 }), run({ run: 2, segment: 2, metrics: { memory: 512 } })] }))
    mounted.showDashboard()
    const rows = mounted.find("experiment-run")
    assert.deepEqual(rows[1]?.properties.classList, { "segment-old": true }, "the first-segment row is history")
    assert.deepEqual(rows[0]?.properties.classList, { "segment-old": false })
    assert.match(mounted.text(), /memory 512 MB/)
    mounted.dispose()
  })

  test("an inactive loop keeps its ledger but says off", () => {
    const mounted = mountExperimentStrip(view({ active: false }))
    assert.match(mounted.text(), /off/)
    assert.doesNotMatch(mounted.text(), /active/)
    mounted.dispose()
  })

  test("the handle is registered on mount and a removed view unmounts the strip", () => {
    const mounted = mountExperimentStrip(view())
    assert.equal(mounted.hasHandle(), true)
    mounted.setView(undefined)
    assert.equal(mounted.text(), "")
    mounted.dispose()
  })
})

describe("experiment figures", () => {
  test("confidence bands follow the pi-autoresearch thresholds", () => {
    assert.equal(confidenceBand(2), "success")
    assert.equal(confidenceBand(1.99), "warning")
    assert.equal(confidenceBand(0.99), "error")
  })

  test("metrics carry their unit and four significant figures", () => {
    assert.equal(formatMetric(12, "ms"), "12 ms")
    assert.equal(formatMetric(0.873412, ""), "0.8734")
    assert.equal(formatMetric(1024, "tokens"), "1,024 tokens")
  })
})

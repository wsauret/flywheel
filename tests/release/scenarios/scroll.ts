/** Scroll input-to-viewport latency and presentation cadence at the terminal boundary.
 * Renderer timings are attribution only: their meaning differs across OpenTUI versions. */
import { cpSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { GIANT_SESSION_ID, GIANT_SESSION_NAME, LIGHT_SESSION_NAME_PREFIX } from "../fixtures/generate-store.js"
import { inWindow, readDebugLogRecords, serviceRecords, type DebugLogRecord } from "../lib/debug-log-reader.js"
import { percentile, type MetricValues } from "../lib/metrics.js"
import { waitFor, writeAccountConfig } from "../lib/isolated-serve.js"
import { controlLiteral, observeTerminal, probeViewport, scrollClock, viewportPresentations, type ScrollObservation } from "../lib/scroll-terminal.js"
import { launchApp, sleep, type TmuxApp } from "../../../scripts/uat/tmux-driver.js"
import { startScrollGrowthProvider, SCROLL_GROWTH_PROMPT } from "./scroll-growth-provider.js"
import { dismissFirstRunModals, READY_MARKER, READY_TIMEOUT_MS, type ScenarioContext, type ScenarioResult } from "./scenario-context.js"

const OPEN_TIMEOUT_MS = 20_000
const KEYS_PER_DIRECTION = 30
const KEY_INTERVAL_MS = 450
const NUMERIC_SCROLL_FIELDS = ["scrollTop", "scrollHeight", "maxScrollTop", "beforeTop", "afterTop", "deltaTop"]
const sgr = (button: number, column: number, row: number, release = false) => `\u001b[<${button};${column};${row}${release ? "m" : "M"}`
type Terminal = ReturnType<typeof observeTerminal>
type Burst = ScrollObservation & { start: number; end: number }

export async function runScrollScenario(context: ScenarioContext): Promise<ScenarioResult> {
  const provider = startScrollGrowthProvider()
  await writeAccountConfig(join(context.workDir, ".flywheel"), provider.config)
  const app = launchApp({
    server: context.tmuxServer, sessionName: context.sessionName, binaryPath: context.binaryPath, workDir: context.workDir,
    stderrFile: join(context.evidenceDir, "stderr.log"),
    env: { ...context.environment, FLYWHEEL_RENDER_DEBUG: "1", FLYWHEEL_LOG_LEVEL: "DEBUG" },
  })
  const failures: string[] = []
  const metrics: MetricValues = {}
  const bursts: Burst[] = []
  let terminal: Terminal | undefined
  const { timeline } = context
  try {
    await timeline.time("ready", () => app.pollPane("ready prompt", pane => pane.includes(READY_MARKER), READY_TIMEOUT_MS, 50))
    await timeline.time("dismiss-modals", () => dismissFirstRunModals(app, context.measurementRole))
    await timeline.time("settle", () => sleep(1500))
    app.sendKeys("C-s")
    await timeline.time("modal-rows", () => app.pollPane("modal rows", pane => pane.includes("Sessions") && pane.includes(GIANT_SESSION_NAME), 15_000, 50))
    app.sendKeys("-l", "Giant")
    await timeline.time("filter-giant", () => app.pollPane("filtered to giant",
      pane => pane.includes(GIANT_SESSION_NAME) && !pane.includes(LIGHT_SESSION_NAME_PREFIX), 15_000, 50))
    const openStarted = performance.now()
    app.sendKeys("Enter")
    await timeline.time("open-giant", () => app.pollPane("giant transcript",
      pane => pane.includes("End of giant fixture transcript.") && !pane.includes("Session Preview"), OPEN_TIMEOUT_MS, 50))
    metrics["scroll.openGiantMs"] = performance.now() - openStarted
    await sleep(2000)
    terminal = observeTerminal(context.tmuxServer, context.sessionName)
    await sleep(500)
    for (const mode of ["drag", "pageKeys", "wheel", "growing"] as const) {
      if (mode === "growing") {
        await app.sendText(SCROLL_GROWTH_PROMPT)
        await waitFor("scroll reply streaming", () => provider.started ? true : undefined, OPEN_TIMEOUT_MS)
        await sleep(500)
      }
      const pane = app.capture()
      const composer = pane.split("\n").findIndex(line => line.startsWith("╭─")) + 1
      if (composer < 5) throw new Error("scroll: composer boundary not found")
      // Exclude the scrollbar column and the bottom Latest row. A spinner or
      // pill repaint must not count as a response to scroll input.
      const viewport = { top: 4, bottom: composer - 4, right: 149 }
      const inputs: number[] = []
      const directions: ScrollObservation["directions"] = []
      const deltas = provider.deltas
      await timeline.time(`burst-${mode}`, () => scrollBurst(app, terminal!, mode, inputs, directions, failures, context, composer - 2))
      const end = scrollClock()
      // Server enqueues are attribution only, sampled before any post-burst probes.
      if (mode === "growing") metrics["scroll.growing.appendedDeltas"] = provider.deltas - deltas
      const probes = await timeline.time(`probes-${mode}`, () => scrollProbes(app, terminal!, mode, composer - 2))
      bursts.push({ mode, start: inputs[0]!, end, inputs, chunks: terminal.chunks, viewport, probes, directions })
      writeFileSync(join(context.evidenceDir, `post-${mode}-pane.log`), app.capture())
      await sleep(500)
    }
  } catch (error) {
    failures.push(`scroll: ${String(error)}`)
    writeFileSync(join(context.evidenceDir, "failure-pane.log"), app.capture())
  } finally {
    await provider.stop()
    await terminal?.close()
    await timeline.time("dispose", () => app.dispose())
  }
  const records = readDebugLogRecords(context.workDir)
  for (const burst of bursts) analyzeBurst(records, burst.start, burst.end, metrics, failures, burst)
  writeFileSync(join(context.evidenceDir, "scroll-terminal.json"), `${JSON.stringify(bursts.map(burst => ({
    mode: burst.mode, start: burst.start, end: burst.end, inputs: burst.inputs, probes: burst.probes, directions: burst.directions,
    frames: viewportPresentations(burst.chunks, burst.viewport).frames.filter(frame => frame.start >= burst.start && frame.end <= burst.end),
  })), null, 2)}\n`)
  if (failures.length > 0) cpSync(join(context.workDir, ".flywheel", "log"), join(context.evidenceDir, "debug-log"), { recursive: true })
  return { metrics, failures }
}

async function scrollBurst(app: TmuxApp, terminal: Terminal, mode: ScrollObservation["mode"], inputs: number[], directions: ScrollObservation["directions"], failures: string[], context: ScenarioContext, trackBottom: number): Promise<void> {
  const send = (keys: string) => { inputs.push(terminal.send(keys)) }
  if (mode === "pageKeys") {
    for (const key of ["PageUp", "PageDown"]) {
      const start = scrollClock()
      for (let i = 0; i < KEYS_PER_DIRECTION; i++) {
        send(key)
        await sleep(KEY_INTERVAL_MS)
        if (i % 10 === 9) {
          const pane = app.capture()
          writeFileSync(join(context.evidenceDir, `burst-${key.toLowerCase()}-${i + 1}.log`), pane)
          if (pane.replaceAll(/\s/g, "").length < 20) failures.push(`scroll: pane nearly blank during ${key} burst at key ${i + 1}`)
        }
      }
      directions.push({ start, end: scrollClock(), direction: key === "PageUp" ? "up" : "down" })
    }
  } else if (mode === "drag") {
    const lines = app.capture().split("\n")
    const thumbRow = lines.findLastIndex((line, row) => row < trackBottom && /[█▀▄▌▐▆▇▅▃▂▁▔]/u.test(Array.from(line).slice(149).join(""))) + 1
    if (thumbRow < 4) throw new Error("scrollbar thumb not found")
    const column = Bun.stringWidth(lines[thumbRow - 1]!.trimEnd())
    terminal.send(`-l ${controlLiteral(sgr(0, column, thumbRow))}`)
    await sleep(100)
    for (const [direction, rows] of [
      ["up", Array.from({ length: thumbRow - 4 }, (_, i) => thumbRow - 1 - i)],
      ["down", Array.from({ length: trackBottom - 4 }, (_, i) => 5 + i)],
    ] as const) {
      const start = scrollClock()
      for (const [i, row] of rows.entries()) {
        await sleep(Math.max(0, start + i * 60 - scrollClock()))
        send(`-l ${controlLiteral(sgr(32, column, row))}`)
      }
      await sleep(150)
      directions.push({ start, end: scrollClock(), direction })
    }
    terminal.send(`-l ${controlLiteral(sgr(0, column, trackBottom, true))}`)
  } else {
    for (const [button, count] of [[64, 600], [65, 400]] as const) {
      const start = scrollClock()
      for (let i = 0; i < count; i++) {
        send(`-l ${controlLiteral(sgr(button, 80, 15))}`)
        await sleep(Math.max(0, start + (i + 1) * 1000 / 120 - scrollClock()))
      }
      await sleep(150)
      directions.push({ start, end: scrollClock(), direction: button === 64 ? "up" : "down" })
    }
  }
  // Include the final input's queued presentation, but not the next case's setup.
  await sleep(150)
}

/** Serialize probes so no later input can steal an earlier input's presentation.
 * The upper transcript must move; streaming at the tail and chrome changes cannot answer a probe. */
async function scrollProbes(app: TmuxApp, terminal: Terminal, mode: ScrollObservation["mode"], trackBottom: number): Promise<ScrollObservation["probes"]> {
  const probes: ScrollObservation["probes"] = []
  const signature = async () => (await terminal.capture()).split("\n").slice(3, 11).map(line => Array.from(line).slice(0, 149).join("")).join("\n")
  // Growth is still active, but the measured region is historical text, away from its mutable tail.
  app.sendKeys("PageUp")
  await sleep(500)
  const stable = await signature()
  await sleep(100)
  if (await signature() !== stable) throw new Error(`scroll.${mode}: upper transcript is not stable before isolated probes`)
  let dragColumn = 0
  let dragRows: number[] = []
  if (mode === "drag") {
    const lines = app.capture().split("\n")
    const thumb = lines.findLastIndex((line, row) => row < trackBottom && /[█▀▄▌▐▆▇▅▃▂▁▔]/u.test(Array.from(line).slice(149).join(""))) + 1
    if (thumb < 4) throw new Error("scrollbar thumb not found for probes")
    dragColumn = Bun.stringWidth(lines[thumb - 1]!.trimEnd())
    dragRows = [
      ...Array.from({ length: thumb - 4 }, (_, i) => thumb - 1 - i),
      ...Array.from({ length: trackBottom - 4 }, (_, i) => 5 + i),
    ]
    terminal.send(`-l ${controlLiteral(sgr(0, dragColumn, thumb))}`)
    await sleep(100)
  }
  try {
    for (let i = 0; i < (mode === "drag" ? dragRows.length : 24); i++) {
      const keys = mode === "drag"
        ? `-l ${controlLiteral(sgr(32, dragColumn, dragRows[i]!))}`
        : mode === "pageKeys" ? (i % 2 === 0 ? "PageUp" : "PageDown")
        : `-l ${controlLiteral(sgr(i % 2 === 0 ? 64 : 65, 80, 15))}`
      const probe = await probeViewport({
        chunks: terminal.chunks, send: () => terminal.send(keys), capture: signature,
        clock: scrollClock, pause: () => sleep(5),
      }, { top: 4, bottom: 11, right: 149 })
      probes.push(probe)
      if (probe.response === undefined) break
      await sleep(150)
    }
  } finally {
    if (mode === "drag") terminal.send(`-l ${controlLiteral(sgr(0, dragColumn, trackBottom, true))}`)
  }
  return probes
}

/** Continuous presentations measure cadence. Only isolated, viewport-confirmed probes measure latency. */
export function analyzeBurst(records: readonly DebugLogRecord[], startTs: number, endTs: number, metrics: MetricValues, failures: string[], observation: ScrollObservation): void {
  const prefix = `scroll.${observation.mode}`
  const windowed = inWindow(records, startTs, endTs)
  if (observation.mode === "growing") {
    const received = windowed.filter(record => {
      if (record.type !== "model.stream.event_observed" || record.sessionId !== GIANT_SESSION_ID
        || record.payload?.source !== "normalized" || record.payload.kind !== "text_delta") return false
      const metadata = record.payload.metadata
      const text = typeof metadata === "object" && metadata !== null && "text" in metadata ? metadata.text : undefined
      return typeof text === "object" && text !== null && "chars" in text && typeof text.chars === "number" && text.chars > 0
    })
    // Stream diagnostics are sampled. A positive sample proves receipt, not the total delta count.
    metrics[`${prefix}.receivedTextSamples`] = received.length
    if (received.length === 0) failures.push(`${prefix}: no application text receipt during the continuous burst`)
  }
  const probeRecords = windowed.filter(record => record.type === "render.frame.summary"
    || (record.payload?.service === "render-probe" && record.payload.message === "render diagnostics"))
  const frameTimes = probeRecords.flatMap(record => {
    const renderer = record.payload?.renderer
    const times = typeof renderer === "object" && renderer !== null && "frameTimes" in renderer ? renderer.frameTimes : undefined
    return Array.isArray(times) ? times.filter((value): value is number => typeof value === "number" && Number.isFinite(value)) : []
  })
  // A summary can contain frames from before its timestamp. These values are
  // deliberately unbudgeted attribution, never terminal cadence or latency.
  if (frameTimes.length > 0) metrics[`${prefix}.rendererP95Ms`] = percentile(frameTimes, 95)
  const frames = viewportPresentations(observation.chunks, observation.viewport).frames.filter(frame => frame.start >= startTs && frame.end <= endTs)
  const inputs = observation.inputs.filter(ts => ts >= startTs && ts <= endTs)
  const latencies = observation.probes.flatMap(probe => probe.response === undefined ? [] : [probe.response - probe.input])
  metrics[`${prefix}.inputs`] = inputs.length
  metrics[`${prefix}.probes`] = observation.probes.length
  metrics[`${prefix}.unobservedProbes`] = observation.probes.length - latencies.length
  metrics[`${prefix}.frames`] = frames.length
  metrics[`${prefix}.fps`] = frames.length * 1000 / (endTs - startTs)
  if (latencies.length === 0) failures.push(`${prefix}: no input reached changed viewport output`)
  if (latencies.length !== observation.probes.length) failures.push(`${prefix}: an isolated input did not reach its changed viewport`)
  if (latencies.length > 0) {
    metrics[`${prefix}.p95InputToOutputMs`] = percentile(latencies, 95)
    metrics[`${prefix}.maxInputToOutputMs`] = Math.max(...latencies)
  }
  const gaps = frames.slice(1).map((frame, index) => frame.end - frames[index]!.end)
  if (gaps.length > 0) {
    metrics[`${prefix}.p95FrameGapMs`] = percentile(gaps, 95)
    metrics[`${prefix}.maxFrameGapMs`] = Math.max(...gaps)
  } else failures.push(`${prefix}: fewer than two viewport presentations in the active window`)
  const responseGaps = observation.directions.flatMap(window => {
    const boundary = serviceRecords(inWindow(records, window.start, window.end), "output-window-scroll").find(record => {
      const state = record.payload
      return window.direction === "up"
        ? state?.hasBefore === false && state.scrollTop === 0
        : state?.hasAfter === false && typeof state.maxScrollTop === "number" && state.scrollTop === state.maxScrollTop
    })
    const end = boundary
      ? frames.find(frame => frame.end >= boundary.ts && frame.end <= window.end)?.end ?? window.end
      : window.end
    const presentations = frames.filter(frame => frame.end >= window.start && frame.end <= end)
    const points = [window.start, ...presentations.map(frame => frame.end), end]
    return points.slice(1).map((point, index) => point - points[index]!)
  })
  if (responseGaps.length > 0) metrics[`${prefix}.maxResponseGapMs`] = Math.max(...responseGaps)
  // Preserve the page-key budget names, now using terminal presentation spans
  // instead of version-dependent renderer.getStats().frameTimes.
  if (observation.mode === "pageKeys" && frames.length > 0) {
    const spans = frames.map(frame => frame.end - frame.start)
    metrics["scroll.p95FrameMs"] = percentile(spans, 95)
    metrics["scroll.maxFrameMs"] = Math.max(...spans)
    metrics["scroll.stallCount"] = spans.filter(span => span > 100).length
  }
  const scrollRecords = serviceRecords(windowed, "output-window-scroll")
  if (!scrollRecords.some(record => record.payload?.message === "scroll position changed")) {
    failures.push(`${prefix}: no scroll-position changes in the active window; the burst did not engage the scroll pipeline`)
  }
  for (const record of scrollRecords) {
    for (const field of NUMERIC_SCROLL_FIELDS) {
      if (!record.payload || !(field in record.payload)) continue
      const value = record.payload[field]
      if (value === null || (typeof value === "number" && !Number.isFinite(value))) failures.push(`${prefix}: non-finite ${field} in scroll telemetry at ts ${record.ts}`)
    }
  }
}

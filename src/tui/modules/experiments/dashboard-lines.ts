import { bold as stBold, fg as stFg, type TextChunk } from "@opentui/core"
import type { FrontendExperimentMetric, FrontendExperimentMetricDirection, FrontendExperimentRun, FrontendExperimentView } from "../../../protocol/modules/experiments.js"
import type { TuiTheme } from "../../context/theme/tui-theme.js"
import { chunkDisplayWidth, truncateChunks } from "../../output-blocks/tools/tool-row-wrap.js"
import { displayWidth, truncateToWidth } from "../../text.js"

/** One rendered dashboard row: styled chunks that fit one terminal line. */
export type DashboardLine = readonly TextChunk[]

/** Upstream semantic color names, mapped once onto the host theme so the copied
 *  renderer keeps its color vocabulary while every value comes from the theme. */
type DashboardColor = "dim" | "muted" | "text" | "success" | "warning" | "error" | "accent" | "borderMuted"

const THEME_KEY = {
  dim: "textSubtle",
  muted: "textMuted",
  text: "text",
  success: "success",
  warning: "warning",
  error: "error",
  accent: "accent",
  borderMuted: "borderSubtle",
} satisfies { readonly [Color in DashboardColor]: keyof TuiTheme }

/** Chunk builders bound to one theme and one line width. */
interface LineStyle {
  fg: (color: DashboardColor, text: string) => TextChunk
  bold: (chunk: TextChunk) => TextChunk
  fit: (chunks: readonly TextChunk[]) => DashboardLine
}

function lineStyle(theme: TuiTheme, width: number): LineStyle {
  const fg = (color: DashboardColor, text: string): TextChunk => stFg(theme[THEME_KEY[color]])(text)
  const ellipsis = fg("dim", "…")
  return { fg, bold: stBold, fit: (chunks) => truncateChunks(chunks, width, ellipsis) }
}

const NO_RUNS_COPY = "No experiments yet."
const BASELINE_PENDING_COPY = "baseline pending"
const CONFIDENCE_PENDING_COPY = "confidence pending"

/** Format a number with comma-separated thousands: 15586 -> "15,586" */
function commas(n: number): string {
  const s = String(Math.round(n))
  const parts: string[] = []
  for (let i = s.length; i > 0; i -= 3) {
    parts.unshift(s.slice(Math.max(0, i - 3), i))
  }
  return parts.join(",")
}

/** Format number with commas, preserving decimals for fractional values */
function fmtNum(n: number, decimals: number = 0): string {
  if (decimals > 0) {
    const int = Math.floor(Math.abs(n))
    const frac = (Math.abs(n) - int).toFixed(decimals).slice(1)
    return (n < 0 ? "-" : "") + commas(int) + frac
  }
  return commas(n)
}

function formatMetricValue(value: number | null, unit: string): string {
  if (value === null) return "—"
  const u = unit || ""
  if (value === Math.round(value)) return fmtNum(value) + u
  return fmtNum(value, 2) + u
}

function isBetter(current: number, best: number, direction: FrontendExperimentMetricDirection): boolean {
  return direction === "lower" ? current < best : current > best
}

function currentResults(results: readonly FrontendExperimentRun[], segment: number): FrontendExperimentRun[] {
  return results.filter((r) => r.segment === segment)
}

function findBaselineMetric(results: readonly FrontendExperimentRun[], segment: number): number | null {
  return currentResults(results, segment)[0]?.metric ?? null
}

function findBaselineRunNumber(results: readonly FrontendExperimentRun[], segment: number): number | null {
  const first = results.find((result) => result.segment === segment)
  return first ? first.run : null
}

interface MetricValues {
  [name: string]: number
}

/** Secondary metric baselines from the first run in the current segment. A
 *  metric that did not exist at baseline time falls back to its first
 *  occurrence in the current segment. */
function findBaselineSecondary(results: readonly FrontendExperimentRun[], segment: number, knownMetrics: readonly FrontendExperimentMetric[]): MetricValues {
  const cur = currentResults(results, segment)
  const base: MetricValues = { ...cur[0]?.metrics }
  for (const sm of knownMetrics) {
    if (base[sm.name] === undefined) {
      for (const r of cur) {
        const val = r.metrics[sm.name]
        if (val !== undefined) {
          base[sm.name] = val
          break
        }
      }
    }
  }
  return base
}

/** Copy of the upstream dashboard table renderer. Styled chunks replace ANSI
 *  strings and the host theme replaces the upstream theme lookup; column
 *  order, summaries, confidence bands, old-segment dimming, and right-first
 *  secondary column dropping are preserved. `maxRows <= 0` renders every run. */
export function renderDashboardLines(view: FrontendExperimentView, width: number, theme: TuiTheme, maxRows: number = 6): DashboardLine[] {
  const style = lineStyle(theme, width)
  if (view.runs.length === 0) return [[style.fg("dim", `  ${NO_RUNS_COPY}`)]]
  return [...summaryLines(view, width, style), [], ...tableLines(view, width, style, maxRows)]
}

/** Runs, Baseline, and Progress lines with the wrapped secondary deltas. */
function summaryLines(view: FrontendExperimentView, width: number, style: LineStyle): DashboardLine[] {
  const best = bestKeptRun(view)
  return [
    runsSummaryLine(view, style),
    baselineLine(view, style),
    ...(best === undefined ? [] : [progressLine(view, best, style), ...secondaryMetricLines(view, best, width, style)]),
  ]
}

/** The kept run of the current segment with the best primary metric; the latest run wins a tie. */
function bestKeptRun(view: FrontendExperimentView): FrontendExperimentRun | undefined {
  let best: FrontendExperimentRun | undefined
  for (const r of view.runs.toReversed()) {
    if (r.segment !== view.segment || r.status !== "keep" || r.metric <= 0) continue
    if (best === undefined || isBetter(r.metric, best.metric, view.direction)) best = r
  }
  return best
}

function runsSummaryLine(view: FrontendExperimentView, { fg, fit }: LineStyle): DashboardLine {
  const { kept, discarded, crashed, checksFailed } = view.runCounts
  const confSuffix: TextChunk[] = view.confidence !== null
    ? [fg(view.confidence >= 2.0 ? "success" : view.confidence >= 1.0 ? "warning" : "error", `  (conf: ${view.confidence.toFixed(1)}×)`)]
    : [fg("muted", `  (${CONFIDENCE_PENDING_COPY})`)]
  return fit([
    fg("muted", "  Runs: "), fg("text", String(view.runs.length)),
    fg("success", `  ${kept} kept`),
    ...confSuffix,
    ...(discarded > 0 ? [fg("warning", `  ${discarded} discarded`)] : []),
    ...(crashed > 0 ? [fg("error", `  ${crashed} crashed`)] : []),
    ...(checksFailed > 0 ? [fg("error", `  ${checksFailed} checks failed`)] : []),
  ])
}

/** The first run's primary metric. */
function baselineLine(view: FrontendExperimentView, { fg, fit }: LineStyle): DashboardLine {
  const baselineRunNumber = findBaselineRunNumber(view.runs, view.segment)
  const baselineSuffix = baselineRunNumber === null ? "" : ` #${baselineRunNumber}`
  return fit([
    fg("muted", "  Baseline: "),
    view.baseline === null
      ? fg("muted", BASELINE_PENDING_COPY)
      : fg("muted", `★ ${view.metric.name}: ${formatMetricValue(view.baseline, view.metric.unit)}${baselineSuffix}`),
  ])
}

/** The best primary metric with its run number and its delta from the baseline. */
function progressLine(view: FrontendExperimentView, best: FrontendExperimentRun, { fg, bold, fit }: LineStyle): DashboardLine {
  const baseline = view.baseline
  const line: TextChunk[] = [
    fg("muted", "  Progress: "),
    bold(fg("warning", `★ ${view.metric.name}: ${formatMetricValue(best.metric, view.metric.unit)}`)),
    fg("dim", ` #${best.run}`),
  ]
  if (baseline !== null && baseline !== 0 && best.metric !== baseline) {
    const pct = ((best.metric - baseline) / baseline) * 100
    const sign = pct > 0 ? "+" : ""
    line.push(fg(isBetter(best.metric, baseline, view.direction) ? "success" : "error", ` (${sign}${pct.toFixed(1)}%)`))
  }
  return fit(line)
}

/** Aligns wrapped secondary metrics under the metric name of the progress line. */
const PROGRESS_VALUE_PREFIX = " ".repeat("  Progress: ★ ".length)

/** The best run's secondary metrics and their deltas, wrapped into lines that fit the width. */
function secondaryMetricLines(view: FrontendExperimentView, best: FrontendExperimentRun, width: number, { fg, fit }: LineStyle): DashboardLine[] {
  if (view.secondaryMetrics.length === 0) return []
  const baselineSec = findBaselineSecondary(view.runs, view.segment, view.secondaryMetrics)
  const maxLineW = width - PROGRESS_VALUE_PREFIX.length
  const secParts: TextChunk[][] = []
  for (const sm of view.secondaryMetrics) {
    const val = best.metrics[sm.name]
    const bv = baselineSec[sm.name]
    if (val === undefined) continue
    const part: TextChunk[] = [fg("muted", `${sm.name}: ${formatMetricValue(val, sm.unit)}`)]
    if (bv !== undefined && bv !== 0 && val !== bv) {
      const p = ((val - bv) / bv) * 100
      const s = p > 0 ? "+" : ""
      part.push(fg(val <= bv ? "success" : "error", ` ${s}${p.toFixed(1)}%`))
    }
    secParts.push(part)
  }
  const lines: DashboardLine[] = []
  let curLine: TextChunk[] = []
  let curVisW = 0
  for (const part of secParts) {
    const partVisW = chunkDisplayWidth(part)
    const sep = curLine.length > 0 ? "  " : ""
    if (curLine.length > 0 && curVisW + sep.length + partVisW > maxLineW) {
      lines.push(fit([fg("dim", PROGRESS_VALUE_PREFIX), ...curLine]))
      curLine = part
      curVisW = partVisW
    } else {
      curLine = sep ? [...curLine, fg("muted", sep), ...part] : [...curLine, ...part]
      curVisW += sep.length + partVisW
    }
  }
  if (curLine.length > 0) lines.push(fit([fg("dim", PROGRESS_VALUE_PREFIX), ...curLine]))
  return lines
}

/** Column widths of the rendered rows. */
interface TableColumns {
  readonly primaryLabel: string
  readonly idx: number
  readonly commit: number
  readonly primary: number
  readonly status: number
  /** Secondary metric columns that have a value in a rendered row and fit the width. */
  readonly secondary: readonly { readonly sm: FrontendExperimentMetric; readonly colW: number }[]
  readonly description: number
}

/** The current segment's baseline run and metric values, for the delta colors. */
interface TableBaseline {
  readonly index: number
  readonly primary: number | null
  readonly secondary: MetricValues
}

/** Column header, rule, hidden-run note, and one row per rendered run. */
function tableLines(view: FrontendExperimentView, width: number, style: LineStyle, maxRows: number): DashboardLine[] {
  const { fg, fit } = style
  const results = view.runs
  const effectiveMax = maxRows <= 0 ? results.length : maxRows
  const startIdx = Math.max(0, results.length - effectiveMax)
  const rowsToRender = results.slice(startIdx)
  const columns = visibleColumns(view, width, rowsToRender)
  const baseline: TableBaseline = {
    index: results.findIndex((x) => x.segment === view.segment),
    primary: findBaselineMetric(results, view.segment),
    secondary: findBaselineSecondary(results, view.segment, view.secondaryMetrics),
  }
  return [
    headerLine(columns, style),
    fit([fg("borderMuted", `  ${"─".repeat(Math.max(0, width - 4))}`)]),
    ...(startIdx > 0 ? [fit([fg("dim", `  … ${startIdx} earlier run${startIdx === 1 ? "" : "s"}`)])] : []),
    ...rowsToRender.map((r, offset) => runRow(view, r, startIdx + offset, columns, baseline, style)),
  ]
}

function visibleColumns(view: FrontendExperimentView, width: number, rowsToRender: readonly FrontendExperimentRun[]): TableColumns {
  const secMetrics = view.secondaryMetrics.filter((sm) => rowsToRender.some((r) => r.metrics[sm.name] !== undefined))

  // "★ " prefix (2 visible) + metric name + 1 padding, clamped to 25% of width
  const primaryLabel = "★ " + (view.metric.name || "metric")
  const primaryW = Math.max(11, Math.min(Math.floor(width * 0.25), displayWidth(primaryLabel) + 1))
  const col = { idx: 3, commit: 8, primary: primaryW, status: 15 }
  const minDescW = Math.max(10, Math.floor(width * 0.25))
  const fixedW = col.idx + col.commit + col.primary + col.status + 6

  // max(name, widest value) + 1 padding
  const secColumns = secMetrics.map((sm) => {
    let maxW = displayWidth(sm.name)
    for (const r of rowsToRender) {
      const val = r.metrics[sm.name]
      if (val !== undefined) maxW = Math.max(maxW, displayWidth(formatMetricValue(val, sm.unit)))
    }
    return { sm, colW: maxW + 1 }
  })

  // Secondary columns drop from the right until they fit.
  let visibleSecColumns = secColumns
  const totalSecWidth = () => visibleSecColumns.reduce((a, { colW }) => a + colW, 0)
  while (visibleSecColumns.length > 0 && totalSecWidth() > width - fixedW - minDescW) {
    visibleSecColumns = visibleSecColumns.slice(0, -1)
  }

  return { primaryLabel, ...col, secondary: visibleSecColumns, description: Math.max(minDescW, width - fixedW - totalSecWidth()) }
}

function headerLine(columns: TableColumns, { fg, bold, fit }: LineStyle): DashboardLine {
  const line: TextChunk[] = [
    fg("muted", `  ${"#".padEnd(columns.idx)}`),
    fg("muted", "commit".padEnd(columns.commit)),
    bold(fg("warning", truncateToWidth(columns.primaryLabel, columns.primary - 1, "…").padEnd(columns.primary))),
  ]
  for (const { sm, colW } of columns.secondary) {
    line.push(fg("muted", sm.name.padEnd(colW)))
  }
  line.push(fg("muted", "status".padEnd(columns.status)), fg("muted", "description"))
  return fit(line)
}

function runRow(view: FrontendExperimentView, r: FrontendExperimentRun, i: number, columns: TableColumns, baseline: TableBaseline, { fg, bold, fit }: LineStyle): DashboardLine {
  const isOld = r.segment !== view.segment
  const isBaseline = !isOld && i === baseline.index

  const color: DashboardColor = isOld
    ? "dim"
    : r.status === "keep"
      ? "success"
      : r.status === "crash" || r.status === "checks_failed"
        ? "error"
        : "warning"

  const primaryStr = formatMetricValue(r.metric, view.metric.unit)
  let primaryColor: DashboardColor = isOld ? "dim" : "text"
  if (!isOld && !isBaseline && baseline.primary !== null && r.status === "keep" && r.metric > 0) {
    if (isBetter(r.metric, baseline.primary, view.direction)) {
      primaryColor = "success"
    } else if (r.metric !== baseline.primary) {
      primaryColor = "error"
    }
  }

  const commitStr = isOld
    ? "(old)".padEnd(columns.commit)
    : r.status !== "keep"
      ? "—".padStart(Math.ceil(columns.commit / 2)).padEnd(columns.commit)
      : r.commit.padEnd(columns.commit)

  const primaryChunk = fg(primaryColor, primaryStr.padEnd(columns.primary))
  const rowLine: TextChunk[] = [
    fg("dim", `  ${String(r.run).padEnd(columns.idx)}`),
    fg(isOld ? "dim" : "accent", commitStr),
    isOld ? primaryChunk : bold(primaryChunk),
  ]

  for (const { sm, colW } of columns.secondary) {
    const val = r.metrics[sm.name]
    if (val !== undefined) {
      const secStr = formatMetricValue(val, sm.unit)
      let secColor: DashboardColor = "dim"
      if (!isOld) {
        const bv = baseline.secondary[sm.name]
        if (isBaseline) {
          secColor = "text"
        } else if (bv !== undefined && bv !== 0) {
          secColor = val <= bv ? "success" : "error"
        }
      }
      rowLine.push(fg(secColor, secStr.padEnd(colW)))
    } else {
      rowLine.push(fg("dim", "—".padEnd(colW)))
    }
  }

  rowLine.push(fg(color, r.status.padEnd(columns.status)), fg("muted", r.description.slice(0, columns.description)))
  return fit(rowLine)
}

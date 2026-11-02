import { bold as stBold, fg as stFg, type TextChunk } from "@opentui/core"
import type { FrontendExperimentMetric, FrontendExperimentMetricDirection, FrontendExperimentRun, FrontendExperimentView } from "../../../protocol/modules/experiments.js"
import type { TuiTheme } from "../../context/theme/resolve.js"
import { chunkDisplayWidth, truncateChunks } from "../../output-blocks/tool-row-wrap.js"
import { displayWidth, truncateToWidth } from "../../utils/text.js"

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

export const NO_RUNS_COPY = "No experiments yet."
export const BASELINE_PENDING_COPY = "baseline pending"
export const CONFIDENCE_PENDING_COPY = "confidence pending"

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
function summaryLines(view: FrontendExperimentView, width: number, { fg, bold, fit }: LineStyle): DashboardLine[] {
  const lines: DashboardLine[] = []
  const results = view.runs
  const segment = view.segment
  const direction = view.direction
  const { kept, discarded, crashed, checksFailed } = view.runCounts

  const baseline = view.baseline
  const baselineRunNumber = findBaselineRunNumber(results, segment)
  const baselineSec = findBaselineSecondary(results, segment, view.secondaryMetrics)

  // Find best kept primary metric and its run number (current segment only)
  let bestPrimary: number | null = null
  let bestSecondary: MetricValues = {}
  let bestRunNum = 0
  for (const r of results.toReversed()) {
    if (r.segment !== segment || r.status !== "keep" || r.metric <= 0) continue
    if (bestPrimary === null || isBetter(r.metric, bestPrimary, direction)) {
      bestPrimary = r.metric
      bestSecondary = r.metrics
      bestRunNum = r.run
    }
  }

  // Runs summary
  const confSuffix: TextChunk[] = view.confidence !== null
    ? [fg(view.confidence >= 2.0 ? "success" : view.confidence >= 1.0 ? "warning" : "error", `  (conf: ${view.confidence.toFixed(1)}×)`)]
    : [fg("muted", `  (${CONFIDENCE_PENDING_COPY})`)]
  lines.push(fit([
    fg("muted", "  Runs: "), fg("text", String(results.length)),
    fg("success", `  ${kept} kept`),
    ...confSuffix,
    ...(discarded > 0 ? [fg("warning", `  ${discarded} discarded`)] : []),
    ...(crashed > 0 ? [fg("error", `  ${crashed} crashed`)] : []),
    ...(checksFailed > 0 ? [fg("error", `  ${checksFailed} checks failed`)] : []),
  ]))

  // Baseline: first run's primary metric
  const baselineSuffix = baselineRunNumber === null ? "" : ` #${baselineRunNumber}`
  lines.push(fit([
    fg("muted", "  Baseline: "),
    baseline === null
      ? fg("muted", BASELINE_PENDING_COPY)
      : fg("muted", `★ ${view.metric.name}: ${formatMetricValue(baseline, view.metric.unit)}${baselineSuffix}`),
  ]))

  // Progress: best primary metric with delta + run number
  if (bestPrimary !== null) {
    const progressLine: TextChunk[] = [
      fg("muted", "  Progress: "),
      bold(fg("warning", `★ ${view.metric.name}: ${formatMetricValue(bestPrimary, view.metric.unit)}`)),
      fg("dim", ` #${bestRunNum}`),
    ]
    if (baseline !== null && baseline !== 0 && bestPrimary !== baseline) {
      const pct = ((bestPrimary - baseline) / baseline) * 100
      const sign = pct > 0 ? "+" : ""
      progressLine.push(fg(isBetter(bestPrimary, baseline, direction) ? "success" : "error", ` (${sign}${pct.toFixed(1)}%)`))
    }
    lines.push(fit(progressLine))

    // Progress secondary metrics: wrap into lines that fit width, indented
    if (view.secondaryMetrics.length > 0) {
      const indent = "            " // 12 chars to align under progress value
      const maxLineW = width - 2 - indent.length // 2 for leading "  "
      const secParts: TextChunk[][] = []
      for (const sm of view.secondaryMetrics) {
        const val = bestSecondary[sm.name]
        const bv = baselineSec[sm.name]
        if (val !== undefined) {
          const part: TextChunk[] = [fg("muted", `${sm.name}: ${formatMetricValue(val, sm.unit)}`)]
          if (bv !== undefined && bv !== 0 && val !== bv) {
            const p = ((val - bv) / bv) * 100
            const s = p > 0 ? "+" : ""
            part.push(fg(val <= bv ? "success" : "error", ` ${s}${p.toFixed(1)}%`))
          }
          secParts.push(part)
        }
      }
      let curLine: TextChunk[] = []
      let curVisW = 0
      for (const part of secParts) {
        const partVisW = chunkDisplayWidth(part)
        const sep = curLine.length > 0 ? "  " : ""
        if (curLine.length > 0 && curVisW + sep.length + partVisW > maxLineW) {
          lines.push(fit([fg("dim", `  ${indent}`), ...curLine]))
          curLine = part
          curVisW = partVisW
        } else {
          curLine = sep ? [...curLine, fg("muted", sep), ...part] : [...curLine, ...part]
          curVisW += sep.length + partVisW
        }
      }
      if (curLine.length > 0) lines.push(fit([fg("dim", `  ${indent}`), ...curLine]))
    }
  }
  return lines
}

/** Column header, rule, hidden-run note, and one row per rendered run. */
function tableLines(view: FrontendExperimentView, width: number, { fg, bold, fit }: LineStyle, maxRows: number): DashboardLine[] {
  const lines: DashboardLine[] = []
  const results = view.runs
  const segment = view.segment
  const direction = view.direction

  // Determine visible rows once, used for both column sizing and rendering
  const effectiveMax = maxRows <= 0 ? results.length : maxRows
  const startIdx = Math.max(0, results.length - effectiveMax)
  const rowsToRender = results.slice(startIdx)

  // Only show secondary metric columns that have at least one value in rendered rows
  const secMetrics = view.secondaryMetrics.filter((sm) => rowsToRender.some((r) => r.metrics[sm.name] !== undefined))

  // Primary column: "★ " prefix (2 visible) + metric name + 1 padding, clamped to 25% of width
  const primaryLabel = "★ " + (view.metric.name || "metric")
  const primaryW = Math.max(11, Math.min(Math.floor(width * 0.25), displayWidth(primaryLabel) + 1))
  const col = { idx: 3, commit: 8, primary: primaryW, status: 15 }
  const minDescW = Math.max(10, Math.floor(width * 0.25))
  const fixedW = col.idx + col.commit + col.primary + col.status + 6

  // Each secondary column width from actual content: max(name, widest value) + 1 padding
  const secColumns = secMetrics.map((sm) => {
    let maxW = displayWidth(sm.name)
    for (const r of rowsToRender) {
      const val = r.metrics[sm.name]
      if (val !== undefined) maxW = Math.max(maxW, displayWidth(formatMetricValue(val, sm.unit)))
    }
    return { sm, colW: maxW + 1 }
  })

  // Drop secondary columns from the right until they fit
  let visibleSecColumns = secColumns
  const totalSecWidth = () => visibleSecColumns.reduce((a, { colW }) => a + colW, 0)
  while (visibleSecColumns.length > 0 && totalSecWidth() > width - fixedW - minDescW) {
    visibleSecColumns = visibleSecColumns.slice(0, -1)
  }

  const descW = Math.max(minDescW, width - fixedW - totalSecWidth())

  // Table header: primary metric name bolded with ★
  const headerLine: TextChunk[] = [
    fg("muted", `  ${"#".padEnd(col.idx)}`),
    fg("muted", "commit".padEnd(col.commit)),
    bold(fg("warning", truncateToWidth(primaryLabel, col.primary - 1, "…").padEnd(col.primary))),
  ]
  for (const { sm, colW } of visibleSecColumns) {
    headerLine.push(fg("muted", sm.name.padEnd(colW)))
  }
  headerLine.push(fg("muted", "status".padEnd(col.status)), fg("muted", "description"))
  lines.push(fit(headerLine))
  lines.push(fit([fg("borderMuted", `  ${"─".repeat(Math.max(0, width - 4))}`)]))

  // Baseline values for delta display (current segment only)
  const baselinePrimary = findBaselineMetric(results, segment)
  const baselineSecondary = findBaselineSecondary(results, segment, view.secondaryMetrics)

  // Recent runs only, with a note about hidden earlier ones
  if (startIdx > 0) {
    lines.push(fit([fg("dim", `  … ${startIdx} earlier run${startIdx === 1 ? "" : "s"}`)]))
  }

  const baselineIndex = results.findIndex((x) => x.segment === segment)

  for (const [offset, r] of rowsToRender.entries()) {
    const i = startIdx + offset
    const isOld = r.segment !== segment
    const isBaseline = !isOld && i === baselineIndex

    const color: DashboardColor = isOld
      ? "dim"
      : r.status === "keep"
        ? "success"
        : r.status === "crash" || r.status === "checks_failed"
          ? "error"
          : "warning"

    // Primary metric with color coding
    const primaryStr = formatMetricValue(r.metric, view.metric.unit)
    let primaryColor: DashboardColor = isOld ? "dim" : "text"
    if (!isOld) {
      if (isBaseline) {
        primaryColor = "text" // baseline row, normal text
      } else if (baselinePrimary !== null && r.status === "keep" && r.metric > 0) {
        if (isBetter(r.metric, baselinePrimary, direction)) {
          primaryColor = "success"
        } else if (r.metric !== baselinePrimary) {
          primaryColor = "error"
        }
      }
    }

    const commitStr = isOld
      ? "(old)".padEnd(col.commit)
      : r.status !== "keep"
        ? "—".padStart(Math.ceil(col.commit / 2)).padEnd(col.commit)
        : r.commit.padEnd(col.commit)

    const primaryChunk = fg(primaryColor, primaryStr.padEnd(col.primary))
    const rowLine: TextChunk[] = [
      fg("dim", `  ${String(r.run).padEnd(col.idx)}`),
      fg(isOld ? "dim" : "accent", commitStr),
      isOld ? primaryChunk : bold(primaryChunk),
    ]

    // Secondary metrics (only visible columns)
    for (const { sm, colW } of visibleSecColumns) {
      const val = r.metrics[sm.name]
      if (val !== undefined) {
        const secStr = formatMetricValue(val, sm.unit)
        let secColor: DashboardColor = "dim"
        if (!isOld) {
          const bv = baselineSecondary[sm.name]
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

    rowLine.push(fg(color, r.status.padEnd(col.status)), fg("muted", r.description.slice(0, descW)))
    lines.push(fit(rowLine))
  }

  return lines
}

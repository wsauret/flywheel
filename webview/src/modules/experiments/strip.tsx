import { createSignal, Show, type Accessor } from "solid-js"
import { keyedRows } from "../../app/keyed-rows.js"

import type { FrontendExperimentRun, FrontendExperimentView } from "../../../../src/protocol/modules/experiments.js"
import { formatDuration } from "../../../../src/protocol/client/format.js"
import { scrollEdges } from "../../app/scroll-edges.js"
import "./strip.css"

/** What the app can ask the strip to do from outside it: `/experiment
 *  dashboard` lands here, so the ledger opens and takes focus instead of a
 *  message being printed into the transcript. */
export interface ExperimentStripHandle {
  showDashboard(): void
}

/** Confidence is the best improvement as a multiple of the noise floor. The
 *  bands are the pi-autoresearch dashboard's: two floors up is likely real, one is
 *  uncertain, below one is inside the noise. Advisory only; nothing here acts
 *  on it. */
export function confidenceBand(confidence: number): "success" | "warning" | "error" {
  if (confidence >= 2) return "success"
  if (confidence >= 1) return "warning"
  return "error"
}

const METRIC_FORMAT = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 })

/** A measured value with its unit: `9.12 ms`, `1,024 tokens`, `0.8734`. */
export function formatMetric(value: number, unit: string): string {
  const figure = METRIC_FORMAT.format(value)
  return unit.length === 0 ? figure : `${figure} ${unit}`
}

const STATUS_LABEL = {
  keep: "kept",
  discard: "discarded",
  crash: "crashed",
  checks_failed: "checks failed",
} satisfies { readonly [status in FrontendExperimentRun["status"]]: string }

/** The experiment loop's ledger for the open session.
 *
 *  The harness measures every attempt and keeps or reverts it, so the strip
 *  answers what a scrolling transcript cannot: where the best stands against
 *  the baseline, how many attempts it took, and whether one is being measured
 *  now. Collapsed it is one line; open it is the run table, newest first,
 *  scrolling inside its own region so a long loop never pushes the composer
 *  off the pane. */
export function ExperimentStrip(props: { readonly view: FrontendExperimentView; readonly register: (handle: ExperimentStripHandle) => void }) {
  const [open, setOpen] = createSignal(false)
  let runs: HTMLDivElement | undefined
  let disclosure: HTMLButtonElement | undefined

  props.register({
    showDashboard: () => {
      setOpen(true)
      // The table mounts under the same synchronous update, so focus can land
      // on it directly; the disclosure is the fallback if it has no rows.
      queueMicrotask(() => (runs ?? disclosure)?.focus())
    },
  })

  const unit = () => props.view.metric.unit
  const title = () => props.view.name ?? "Experiment"
  const counts = () => props.view.runCounts
  const countsLabel = () => {
    const { total, kept } = counts()
    return `${total} ${total === 1 ? "run" : "runs"}${total > 0 ? ` · ${kept} kept` : ""}`
  }
  const isCurrentSegment = (run: FrontendExperimentRun) => run.segment === props.view.segment
  const newestFirst = () => props.view.runs.toReversed()
  const secondary = (run: FrontendExperimentRun) =>
    props.view.secondaryMetrics
      .filter((metric) => run.metrics[metric.name] !== undefined)
      .map((metric) => `${metric.name} ${formatMetric(run.metrics[metric.name] ?? 0, metric.unit)}`)
      .join(" · ")

  const renderRun = (run: Accessor<FrontendExperimentRun>) => (
    <div class={`experiment-run status-${run().status}`} classList={{ "segment-old": !isCurrentSegment(run()) }} role="listitem">
      <span class="experiment-run-number">#{run().run}</span>
      <span class={`dot dot-run-${run().status}`} />
      <span class="experiment-run-status">{STATUS_LABEL[run().status]}</span>
      <span class="experiment-run-metric">{formatMetric(run().metric, unit())}</span>
      <Show when={secondary(run())}><span class="experiment-run-secondary">{secondary(run())}</span></Show>
      <span class="experiment-run-detail">
        <Show when={run().description}><span class="experiment-run-description" title={run().description}>{run().description}</span></Show>
        <Show when={run().durationMs !== null}><span class="experiment-run-duration">{formatDuration(run().durationMs ?? 0)}</span></Show>
      </span>
      <Show when={run().confidence !== null}>
        <span class={`experiment-confidence band-${confidenceBand(run().confidence ?? 0)}`}>{(run().confidence ?? 0).toFixed(1)}x</span>
      </Show>
    </div>
  )
  return (
    <div class="experiment-strip" classList={{ open: open(), running: props.view.running, inactive: !props.view.active }}>
      <div class="experiment-strip-header">
        <button ref={(el) => (disclosure = el)} class="disclosure" aria-expanded={open()} aria-controls="experiment-runs" onClick={() => setOpen((current) => !current)}>
          <span class="chevron">{open() ? "▾" : "▸"}</span>
          <span class="experiment-title">{title()}</span>
          {/* One line, the dashboard's summary row: best against baseline in
              the primary metric, then the tally, then how sure the harness is
              that the gain is real. */}
          <span class="experiment-inline">
            <span class="experiment-figure">
              <span class="experiment-figure-label">best</span>
              <Show when={props.view.best !== null} fallback={<span class="experiment-pending">pending</span>}>
                {formatMetric(props.view.best ?? 0, unit())}
              </Show>
            </span>
            <span class="experiment-figure">
              <span class="experiment-figure-label">baseline</span>
              <Show when={props.view.baseline !== null} fallback={<span class="experiment-pending">pending</span>}>
                {formatMetric(props.view.baseline ?? 0, unit())}
              </Show>
            </span>
            <span class="experiment-figure">{countsLabel()}</span>
            <Show when={props.view.confidence !== null}>
              <span class={`experiment-confidence band-${confidenceBand(props.view.confidence ?? 0)}`} title="Best improvement as a multiple of the noise floor. Advisory only.">
                {(props.view.confidence ?? 0).toFixed(1)}x
              </span>
            </Show>
          </span>
          <span class="tool-detail">
            <Show when={props.view.running} fallback={props.view.active ? "active" : "off"}>
              <span class="experiment-busy" aria-hidden="true" />
              measuring
            </Show>
          </span>
        </button>
      </div>
      <Show when={open()}>
        <div id="experiment-runs" ref={(el) => { runs = el; scrollEdges(el) }} class="experiment-runs scroll-edges" role="list" tabIndex={0} aria-label={`${title()} runs, newest first`}>
          <div class="experiment-runs-content" ref={parent => keyedRows(parent, newestFirst, run => `${run.segment}:${run.run}`, renderRun)}>
          <Show when={props.view.running}>
            <div class="experiment-run pending" role="listitem" aria-busy="true">
              <span class="experiment-run-number">#{props.view.runs.length + 1}</span>
              <span class="dot dot-run-pending" />
              <span class="experiment-run-status">measuring</span>
              <span class="experiment-run-metric experiment-pending">pending</span>
            </div>
          </Show>
          <Show when={props.view.runs.length === 0 && !props.view.running}>
            <div class="experiment-empty" role="listitem">No runs recorded yet. The loop logs one row per measured attempt.</div>
          </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}

import "./sheet.css"
import { createResource, createSignal, For, onMount, Show } from "solid-js"
import { Key } from "@solid-primitives/keyed"

import { USAGE_HISTORY_RANGES, type UsageAccountSource, type UsageHistoryRange, historySeries, spendSeries, type HistorySeries, USAGE_COMMAND_NAME } from "../../../../src/protocol/modules/subscription-usage.js"
import { actionKey } from "../../client/action-key.js"
import { describeFailure } from "../../client/failure-message.js"

import { accountStatus, accountSubtitle, activityLines, detailMetricCount, detailWindowCount, metricBars, prepaidBalanceLines, providerNotice, shortDate, spendGroups, type MetricBar, type UsageLine } from "./usage-format.js"
import { useClient } from "../../app/client-context.js"
import { SheetSegment } from "../../app/sheets/controls.js"
import { Sheet, SheetEmpty, SheetLoading, SheetRow } from "../../app/sheets/sheet.js"

/** What is left on each subscription, what has been spent, and how usage has
 *  moved, laid out the way the terminal's usage modal is: three views in one
 *  frame, one reading per account, and the open account's allowance, banked
 *  reset, and Flywheel activity beneath it. Opening the sheet starts refreshes
 *  for stale provider readings; the list paints from the last reading and
 *  repaints as new ones land. A banked reset the provider offers is applied
 *  from here, on the exact reviewed authority revision, so a stale review
 *  cannot consume another entitlement (PI-MODEL-006). */

const SCOPE = { kind: "defaults" } as const
type View = "accounts" | "spend" | "history"
const VIEWS: readonly { readonly value: View; readonly label: string }[] = [{ value: "accounts", label: "Accounts" }, { value: "spend", label: "Spend" }, { value: "history", label: "History" }]
const RANGES = USAGE_HISTORY_RANGES.map((range) => ({ value: range, label: range }))

interface UsageStatus {
  readonly text: string
  readonly warn: boolean
}

export function UsageSheet(props: { readonly initialView?: "accounts" | "spend" | "history" }) {
  const client = useClient()
  const auth = () => client.state().authStatus?.auth
  const [view, setView] = createSignal<View>(props.initialView ?? "accounts")
  const [generation, setGeneration] = createSignal(0)
  const reread = () => setGeneration((count) => count + 1)
  const [openId, setOpenId] = createSignal<string | undefined>()
  const [showDetail, setShowDetail] = createSignal(false)
  const [spendRange, setSpendRange] = createSignal<UsageHistoryRange>("Month")
  const [historyRange, setHistoryRange] = createSignal<UsageHistoryRange>("24h")
  const [historySourceId, setHistorySourceId] = createSignal<string | undefined>()

  onMount(() => {
    void client.connection.dispatch({ type: "usage.open", scope: SCOPE }).catch(() => undefined)
  })

  const [usage] = createResource(generation, () => client.connection.query({ type: "usage.accounts", scope: SCOPE }))
  const [spend] = createResource(() => (view() === "spend" ? { range: spendRange(), generation: generation() } : undefined), (key) => client.connection.query({ type: "usage.spend", scope: SCOPE, range: key.range }))
  const [history] = createResource(() => (view() === "history" ? { range: historyRange(), generation: generation() } : undefined), (key) => client.connection.query({ type: "usage.history", scope: SCOPE, range: key.range }))

  const failed = (verb: string) => (cause: unknown) => client.report("warning", `Flywheel could not ${verb}: ${describeFailure(cause)}`)

  // Refresh and Apply reset work from the tap, or the confirmation, until the runtime answers.
  const refreshKey = actionKey("subscription-usage.refresh")
  const resetKey = (source: UsageAccountSource) => actionKey("subscription-usage.reset", source.sourceId)
  const refresh = () => {
    void client.actions.run(refreshKey, () => client.connection.dispatch({ type: "usage.refresh", scope: SCOPE })
      .then(() => { client.report("info", "Asking every provider for a fresh reading."); reread() }), failed("refresh usage"))
  }

  // The status beside the view switch: what is loading, what failed, or when
  // the reading is from. One line that changes in place, as the terminal's
  // tab row does, so the sheet never grows a row for it.
  const active = () => (view() === "accounts" ? usage : view() === "spend" ? spend : history)
  const status = (): UsageStatus => {
    const resource = active()
    if (resource.loading) return { text: resource.latest === undefined ? "Reading…" : "Refreshing…", warn: false }
    if (resource.error !== undefined) return { text: `Could not read: ${describeFailure(resource.error)}`, warn: true }
    const asOf = resource.latest?.asOf
    return { text: asOf === undefined ? "" : `As of ${new Date(asOf).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`, warn: false }
  }

  const sources = () => usage.latest?.sources ?? []
  const now = () => usage.latest?.asOf ?? Date.now()
  // Every account starts closed, so the list reads as a list of readings; a
  // tap opens one and a second tap on it closes it, one open at a time.
  const openSource = () => sources().find((source) => source.sourceId === openId())
  const toggle = (sourceId: string) => setOpenId((current) => (current === sourceId ? undefined : sourceId))

  const redeem = async (current: NonNullable<typeof usage.latest>, source: UsageAccountSource) => {
    const result = await client.connection.dispatch({ type: "usage.apply_reset", scope: SCOPE, sourceId: source.sourceId, authorityIncarnation: current.authorityIncarnation, revision: current.revision, redeemRequestId: crypto.randomUUID() })
    const messages = {
      reset: "The provider reset the limit.",
      nothingToReset: "The provider had nothing to reset.",
      noCredit: "No banked reset is available.",
      alreadyRedeemed: "That reset was already used.",
      uncertain: "The provider did not confirm the reset. Refresh to see the outcome.",
      stale: "Usage changed since this was read. Refresh and try again.",
    } as const
    client.report(result.kind === "reset" ? "info" : "warning", messages[result.kind])
    reread()
  }

  const applyReset = (source: UsageAccountSource) => {
    const current = usage.latest
    if (!current || source.kind !== "subscription" || !source.bankedResets) return
    const credit = source.bankedResets.credits[0]
    const run = async () => {
      const confirmed = await client.confirm({
        title: credit?.title ?? "Apply a banked reset?",
        detail: [credit?.description, credit?.expiresAtMs ? `Expires ${new Date(credit.expiresAtMs).toLocaleString()}.` : undefined, "The provider decides at redemption whether a limit resets."].filter(Boolean).join(" "),
        confirmLabel: "Apply reset",
      })
      if (!confirmed) return
      await client.actions.run(resetKey(source), () => redeem(current, source), failed("apply the reset"))
    }
    void run().catch(failed("apply the reset"))
  }

  const historySources = () => history.latest?.sources ?? []
  const historySource = () => historySources().find((source) => source.sourceId === historySourceId()) ?? historySources()[0]

  return (
    <Sheet title={USAGE_COMMAND_NAME} onClose={client.closeSheet} tools={<button class="ghost-text" aria-busy={client.actions.working(refreshKey) || undefined} onClick={refresh}>Refresh</button>}>
      <div class="usage-bar">
        <SheetSegment value={view()} options={VIEWS} label="Usage view" onChange={setView} />
        <span class="usage-status" classList={{ warn: status().warn }} aria-live="polite">{status().text}</span>
      </div>

      <Show when={view() === "accounts"}>
        <Show when={usage.latest} fallback={<Show when={!usage.loading} fallback={<SheetLoading />}><SheetEmpty>Could not read usage.</SheetEmpty></Show>}>
          <Show when={sources().length > 0} fallback={<SheetEmpty>No connected account reports usage.</SheetEmpty>}>
            <Key each={sources()} by="sourceId">
              {(source) => {
                const open = () => openSource()?.sourceId === source().sourceId
                const reading = () => accountStatus(source())
                return (
                  <div class="usage-account" classList={{ open: open() }}>
                    <SheetRow label={source().label} detail={accountSubtitle(source(), auth())} value={<span classList={{ [`tone-${reading().tone ?? "plain"}`]: true }}>{reading().text}</span>} onClick={() => toggle(source().sourceId)} />
                    <Show when={open()}>
                      <AccountDetail source={source()} now={now()} showDetail={showDetail()} onToggleDetail={() => setShowDetail((current) => !current)} applyingReset={client.actions.working(resetKey(source()))} onApplyReset={() => applyReset(source())} />
                    </Show>
                  </div>
                )
              }}
            </Key>
          </Show>
        </Show>
      </Show>

      <Show when={view() === "spend"}>
        <div class="usage-bar"><SheetSegment value={spendRange()} options={RANGES} label="Spend range" onChange={setSpendRange} /></div>
        <Show when={spend.latest} fallback={<Show when={!spend.loading}><SheetEmpty>Could not read spend.</SheetEmpty></Show>}>
          {(result) => (
            <For each={spendGroups(result())}>
              {(group) => (
                <>
                  <div class="sheet-section">{group.title}</div>
                  <Show when={group.summary}>{(summary) => <div class="usage-summary" classList={{ [`tone-${group.tone ?? "plain"}`]: true }}>{summary()}</div>}</Show>
                  <Show when={group.lines.length > 0} fallback={<Show when={group.title !== "Totals"}><div class="usage-summary">No models recorded</div></Show>}>
                    <For each={group.lines}>{(line) => <LineRow line={line} />}</For>
                  </Show>
                </>
              )}
            </For>
          )}
        </Show>
        <Show when={spend.latest !== undefined && spend.latest.sources.length === 0}><div class="sheet-section">By source</div><div class="usage-summary">No spend recorded</div></Show>
      </Show>

      <Show when={view() === "history"}>
        <div class="usage-bar"><SheetSegment value={historyRange()} options={RANGES} label="History range" onChange={setHistoryRange} /></div>
        <Show when={history.latest} fallback={<Show when={!history.loading}><SheetEmpty>Could not read history.</SheetEmpty></Show>}>
          <Show when={historySources().length > 0} fallback={<SheetEmpty>No provider readings in this range.</SheetEmpty>}>
            <div class="usage-bar usage-sources"><SheetSegment value={historySource()?.sourceId ?? ""} options={historySources().map((source) => ({ value: source.sourceId, label: source.label }))} label="History source" onChange={setHistorySourceId} /></div>
            <Show when={historySource()}>
              {(source) => {
                const range = () => ({ startMs: history.latest?.startMs ?? 0, endMs: history.latest?.endMs ?? now() })
                const series = () => [...historySeries(source(), showDetail()), ...spendSeries(source(), range().startMs)]
                return (
                  <>
                    <div class="sheet-section">{source().kind === "metered" ? "Spend over time" : `Use over time · ${source().count} reading${source().count === 1 ? "" : "s"}`}</div>
                    <Show when={series().length > 0} fallback={<div class="usage-summary">{source().kind === "metered" ? "No spend in this range." : "No readings in this range."}</div>}>
                      <div class="usage-charts"><For each={series()}>{(line) => <HistoryChart series={line} startMs={range().startMs} endMs={range().endMs} />}</For></div>
                    </Show>
                    <Show when={detailWindowCount(source().latest) > 0}>
                      <button class="ghost-text usage-toggle" onClick={() => setShowDetail((current) => !current)}>{showDetail() ? "Hide detail windows" : "Show detail windows"}</button>
                    </Show>
                  </>
                )
              }}
            </Show>
          </Show>
        </Show>
      </Show>
    </Sheet>
  )
}

/** The open account: its provider allowance as one bar per window, the banked
 *  reset with the action to apply it, and what Flywheel did in the window. */
function AccountDetail(props: { readonly source: UsageAccountSource; readonly now: number; readonly showDetail: boolean; readonly onToggleDetail: () => void; readonly applyingReset: boolean; readonly onApplyReset: () => void }) {
  const bars = () => metricBars(props.source, props.now, props.showDetail)
  const notice = () => providerNotice(props.source)
  const detail = () => detailMetricCount(props.source)
  const resets = () => (props.source.kind === "subscription" && props.source.bankedResets !== undefined && props.source.bankedResets.availableCount > 0 ? props.source.bankedResets : undefined)
  const expiry = (value: number | null | undefined) => (value === null ? "does not expire" : value === undefined ? "expiry unknown" : `expires ${new Date(value).toLocaleDateString(undefined, { dateStyle: "long" })}`)
  const resetText = (credit: NonNullable<Extract<UsageAccountSource, { kind: "subscription" }>["bankedResets"]>["credits"][number]) => `${credit.title ?? "Full reset"} ${expiry(credit.expiresAtMs)}`
  return (
    <div class="usage-detail">
      <Show when={props.source.kind === "subscription"}>
        <div class="sheet-section">Provider allowance</div>
        <Show when={notice()}>{(line) => <LineRow line={line()} />}</Show>
        <Show when={bars().length > 0} fallback={<Show when={!notice()}><div class="usage-summary">Provider allowance unavailable</div></Show>}>
          <div class="usage-metrics"><For each={bars()}>{(bar) => <MetricLine bar={bar} />}</For></div>
        </Show>
        <Show when={detail() > 0}>
          <button class="ghost-text usage-toggle" onClick={props.onToggleDetail}>{props.showDetail ? "Hide detail windows" : `Show ${detail()} detail window${detail() === 1 ? "" : "s"}`}</button>
        </Show>
      </Show>
      <Show when={props.source.kind === "metered" && props.source.observation !== undefined}>
        <div class="sheet-section">Prepaid balance</div>
        <Show when={notice()}>{(line) => <LineRow line={line()} />}</Show>
        <For each={prepaidBalanceLines(props.source)} fallback={<Show when={!notice()}><div class="usage-summary">Prepaid balance unavailable</div></Show>}>{(line) => <LineRow line={line} />}</For>
      </Show>
      <Show when={resets()}>
        {(credit) => (
          <>
            <div class="sheet-section">Banked reset</div>
            <div class="usage-reset">
              <Show when={credit().credits[0]} fallback={<span class="usage-reset-text">{credit().availableCount} available · details unavailable</span>}>{(first) => <>
                <Show when={credit().credits.length > 1} fallback={<span class="usage-reset-text">{resetText(first())}</span>}>
                  <ul class="usage-reset-list"><For each={credit().credits}>{(item) => <li>{resetText(item)}</li>}</For></ul>
                </Show>
              </>}</Show>
              <button class="primary" aria-busy={props.applyingReset || undefined} onClick={props.onApplyReset}>Apply reset</button>
            </div>
          </>
        )}
      </Show>
      <For each={activityLines(props.source)}>{(line) => <LineRow line={line} />}</For>
    </div>
  )
}

/** The chart's drawing box. The SVG stretches to the sheet's width and keeps
 *  this height, so the path is drawn in these units and scaled. */
const CHART_W = 320
const CHART_H = 56
/** Reset marks are drawn only while they can be told apart. A window that
 *  resets every few hours shows its resets as the line's own drops, and the
 *  count under the chart says how many there were. */
const MAX_RESET_MARKS = 8

/** One window's use over the range: the line rises as the window fills and
 *  drops where the provider reset it, which the marks name. Percent used on
 *  the vertical, the range on the horizontal, and the two readings a person
 *  asks history for beneath: where it is now and how close it came to full. */
function HistoryChart(props: { readonly series: HistorySeries; readonly startMs: number; readonly endMs: number }) {
  const span = () => Math.max(1, props.endMs - props.startMs)
  const x = (atMs: number) => ((Math.min(props.endMs, Math.max(props.startMs, atMs)) - props.startMs) / span()) * CHART_W
  const y = (fraction: number) => CHART_H - fraction * (CHART_H - 2) - 1
  const line = () => props.series.points.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.atMs).toFixed(1)},${y(point.fraction).toFixed(1)}`).join(" ")
  const area = () => {
    const points = props.series.points
    const first = points[0]
    const last = points[points.length - 1]
    return first === undefined || last === undefined ? "" : `${line()} L${x(last.atMs).toFixed(1)},${CHART_H} L${x(first.atMs).toFixed(1)},${CHART_H} Z`
  }
  const readings = () => [props.series.latest, props.series.peak].filter((part): part is string => part !== undefined).join(" · ")
  return (
    <div class="usage-chart" classList={{ [`tone-${props.series.tone ?? "plain"}`]: true }}>
      <span class="usage-metric-head">
        <span class="usage-metric-label">{props.series.label}</span>
        <span class="usage-metric-reading" classList={{ [`tone-${props.series.tone ?? "plain"}`]: true }}>{readings()}</span>
      </span>
      <svg class="usage-chart-plot" viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" role="img" aria-label={`${props.series.label}: ${props.series.points.length} readings, ${readings()}`}>
        <line class="usage-chart-grid" x1="0" y1={y(0.5)} x2={CHART_W} y2={y(0.5)} />
        <line class="usage-chart-grid" x1="0" y1={y(1)} x2={CHART_W} y2={y(1)} />
        <Show when={props.series.resets.length <= MAX_RESET_MARKS}><For each={props.series.resets}>{(atMs) => <line class="usage-chart-reset" x1={x(atMs)} y1="0" x2={x(atMs)} y2={CHART_H} />}</For></Show>
        {/* A lone reading is a short level mark rather than a dot: the plot
            stretches to the sheet's width, and a circle would stretch with it. */}
        <Show when={props.series.points.length > 1} fallback={<For each={props.series.points}>{(point) => <line class="usage-chart-mark" x1={x(point.atMs) - 4} y1={y(point.fraction)} x2={x(point.atMs) + 4} y2={y(point.fraction)} />}</For>}>
          <path class="usage-chart-area" d={area()} />
          <path class="usage-chart-line" d={line()} />
        </Show>
      </svg>
      <span class="usage-chart-axis"><span>{shortDate(props.startMs)}</span><span>{props.series.resets.length > 0 ? `${props.series.resets.length} reset${props.series.resets.length === 1 ? "" : "s"}` : ""}</span><span>{shortDate(props.endMs)}</span></span>
    </div>
  )
}

function LineRow(props: { readonly line: UsageLine }) {
  return <SheetRow label={props.line.label} value={props.line.value} detail={props.line.detail} tone={props.line.tone} />
}

/** One window: its name and reading on a line, the bar beneath, then when it resets. */
function MetricLine(props: { readonly bar: MetricBar }) {
  const percent = () => Math.round((props.bar.fraction ?? 0) * 100)
  return (
    <div class="usage-metric">
      <span class="usage-metric-head">
        <span class="usage-metric-label">{props.bar.label}</span>
        <span class="usage-metric-reading" classList={{ [`tone-${props.bar.tone ?? "plain"}`]: true }}>{props.bar.reading}</span>
      </span>
      <Show when={props.bar.fraction !== undefined}>
        <span class="sheet-bar" classList={{ warn: props.bar.tone === "warn", hot: props.bar.tone === "error" }} role="progressbar" aria-valuenow={percent()} aria-valuemin={0} aria-valuemax={100} aria-label={`${props.bar.label} used`}>
          <span class="sheet-bar-fill" style={{ width: `${percent()}%` }} />
        </span>
      </Show>
      <Show when={props.bar.note}>{(note) => <span class="usage-metric-note">{note()}</span>}</Show>
    </div>
  )
}

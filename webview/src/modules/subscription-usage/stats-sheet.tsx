import { createEffect, createMemo, createResource, on, onCleanup, Show, For } from "solid-js"
import { Key } from "@solid-primitives/keyed"

import { formatUsd, generationSpeedLines, type UsageSessionStats, USAGE_SPEND_SURFACE, USAGE_STATS_COMMAND_NAME } from "../../../../src/protocol/modules/subscription-usage.js"
import { readRetainedQuery, type QueryReading } from "../../../../src/protocol/client/retained-query.js"
import { useClient } from "../../app/client-context.js"
import { Sheet, SheetEmpty, SheetLoading, SheetRow } from "../../app/sheets/sheet.js"
import { describeFailure } from "../../client/failure-message.js"
import { tokenLines } from "./usage-format.js"

/** Session accounting is read only while this sheet is mounted. */
export function StatsSheet() {
  const client = useClient()
  const sessionId = createMemo(() => client.state().sessionId)
  const [stats, { refetch }] = createResource(
    sessionId,
    (id, { value }): Promise<QueryReading<UsageSessionStats>> =>
      readRetainedQuery(id, () => client.connection.query({ type: "usage.stats", sessionId: id }), value),
  )
  const refresh = () => { if (sessionId() && !stats.loading) void refetch() }
  createEffect(on(sessionId, (id) => {
    if (id === undefined) return
    const timer = setInterval(refresh, 5_000)
    onCleanup(() => clearInterval(timer))
  }))
  const reading = () => stats.latest?.key === sessionId() ? stats.latest : undefined
  const current = () => reading()?.value
  const error = () => reading()?.error
  const generation = createMemo(() => {
    const data = current()
    return data === undefined ? undefined : generationSpeedLines(data.generation)
  })
  return (
    <Sheet title={USAGE_STATS_COMMAND_NAME} onClose={client.closeSheet} tools={<button class="ghost-text" onClick={refresh}>{error() ? "Retry" : "Refresh"}</button>}>
      <Show when={sessionId() !== undefined} fallback={<SheetEmpty>No active session. Select a session to see its stats.</SheetEmpty>}>
        <div class="usage-summary">This session, including descendant work</div>
        <Show when={error()}>{(message) => <div class="usage-summary" role="alert">Could not read stats: {describeFailure(message())}. Retry to update.</div>}</Show>
        <Show when={stats.loading && current()}><div class="usage-summary" aria-live="polite">Refreshing…</div></Show>
        <Show when={current()} fallback={<Show when={stats.loading} fallback={<SheetEmpty>Stats unavailable. Retry to update.</SheetEmpty>}><SheetLoading /></Show>}>
          {(data) => (
            <>
              <Show when={data().partial}><div class="usage-summary">Partial: some usage is missing.</div></Show>
              <Show when={data().totals.priceUnavailable}><div class="usage-summary">Some prices are unavailable.</div></Show>
              <div class="sheet-section">Reported usage</div>
              <Key each={tokenLines(data().totals.tokens, data().totals)} by="label">{(line) => <SheetRow label={line().label} value={line().value} detail={line().detail} tone={line().tone} />}</Key>
              <div class="usage-summary">Cache hits are cached input divided by total reported input, including cache writes.</div>
              <SheetRow label="Billed" value={formatUsd(data().totals.estimatedBilledUsd)} />
              <SheetRow label="Subscription-equivalent value" value={formatUsd(data().totals.includedValueUsd)} />
              <SheetRow label="Tool calls" value={data().tools.reduce((sum, tool) => sum + tool.calls, 0).toLocaleString()} />
              <SheetRow label="Tool errors" value={data().tools.reduce((sum, tool) => sum + tool.errors, 0).toLocaleString()} />
              <div class="sheet-section">Cost by session</div>
              <SheetRow label="Direct billed" value={formatUsd(data().direct.estimatedBilledUsd)} />
              <SheetRow label="Direct subscription-equivalent value" value={formatUsd(data().direct.includedValueUsd)} />
              <SheetRow label={`${data().descendantCount.toLocaleString()} descendant${data().descendantCount === 1 ? "" : "s"} billed`} value={formatUsd(data().descendants.estimatedBilledUsd)} />
              <SheetRow label="Descendant subscription-equivalent value" value={formatUsd(data().descendants.includedValueUsd)} />
              <Show when={generation()}>{(speed) => (
                <div class="usage-detail-group">
                  <div class="sheet-section">Generation speed</div>
                  <Key each={speed().rows} by="label">{(line) => <SheetRow label={line().label} detail={line().value} />}</Key>
                  <For each={speed().coverageLines}>{(line) => <div class="usage-summary">{line}</div>}</For>
                  <div class="usage-summary">{speed().basisLine}</div>
                </div>
              )}</Show>
              <details class="usage-details"><summary>Models</summary>
                <Key each={data().models} by="model" fallback={<div class="usage-summary">No models recorded</div>}>{(model) => (
                  <div class="usage-detail-group">
                    <div class="sheet-section">{model().model}</div>
                    <Key each={tokenLines(model().tokens, model())} by="label">{(line) => <SheetRow label={line().label} value={line().value} detail={line().detail} tone={line().tone} />}</Key>
                    <SheetRow label="Billed" value={formatUsd(model().estimatedBilledUsd)} />
                    <SheetRow label="Subscription-equivalent value" value={formatUsd(model().includedValueUsd)} />
                    <Show when={model().priceUnavailable}><div class="usage-summary">Price unavailable</div></Show>
                  </div>
                )}</Key>
              </details>
              <details class="usage-details"><summary>Tools</summary>
                <Key each={data().tools} by="name" fallback={<div class="usage-summary">No tools recorded</div>}>{(tool) => (
                  <div class="usage-detail-group">
                    <div class="sheet-section">{tool().name}</div>
                    <SheetRow label="Calls" value={tool().calls.toLocaleString()} />
                    <SheetRow label="Errors" value={tool().errors.toLocaleString()} />
                    <Show when={tool().blocked + tool().cancelled + tool().interrupted + tool().stopped > 0}>
                      <SheetRow label="Other outcomes" detail={`${tool().blocked.toLocaleString()} blocked · ${tool().cancelled.toLocaleString()} cancelled · ${tool().interrupted.toLocaleString()} interrupted · ${tool().stopped.toLocaleString()} stopped`} />
                    </Show>
                  </div>
                )}</Key>
              </details>
            </>
          )}
        </Show>
      </Show>
      <div class="usage-bar"><button class="ghost-text" onClick={() => client.openSurface(USAGE_SPEND_SURFACE)}>Overall usage</button></div>
    </Sheet>
  )
}

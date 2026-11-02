/** @jsxImportSource @opentui/solid */
import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { Key } from "@solid-primitives/keyed"
import type { ScrollBoxRenderable } from "@opentui/core"
import { readRetainedQuery, type QueryReading } from "../../../protocol/client/retained-query.js"
import { generationSpeedLines, USAGE_SPEND_SURFACE, type UsageSessionStats, type UsageStatsSummary, USAGE_STATS_COMMAND_NAME } from "../../../protocol/modules/subscription-usage.js"
import { Button } from "../../components/button.js"
import { ModalFrame } from "../../components/modal-frame.js"
import { computeModalWidth } from "../../components/modal-layout.js"
import { createModalScrollController } from "../../components/modal-scroll-controller.js"
import type { ModalHandle } from "../../components/modal-stack.js"
import { useTheme } from "../../context/theme.js"
import { useModalDimensions } from "../../hooks/use-modal-dimensions.js"
import type { TuiControllerHost } from "../../tui-module.js"
import { BOLD } from "../../utils/text-attributes.js"
import { UsageTokenLines } from "./token-lines.js"

function CostLine(props: { label: string; summary: UsageStatsSummary }) {
  const { theme } = useTheme()
  return <text fg={theme.text}>{`${props.label}  $${props.summary.estimatedBilledUsd.toFixed(2)} billed · $${props.summary.includedValueUsd.toFixed(2)} subscription-equivalent value${props.summary.priceUnavailable ? " · some prices unavailable" : ""}`}</text>
}

/** Owns refresh only for the open modal. Solid's resource discards results from
 * an old session key, while its latest reading remains visible during refresh. */
export function createStatsSurface(host: TuiControllerHost): () => void {
  const { theme } = useTheme()
  const [sessionId, setSessionId] = createSignal<string>()
  const [modelsOpen, setModelsOpen] = createSignal(false)
  const [toolsOpen, setToolsOpen] = createSignal(false)
  const [stats, { refetch, mutate }] = createResource(sessionId, (id, { value }): Promise<QueryReading<UsageSessionStats>> =>
    readRetainedQuery(id, () => host.client.query({ type: "usage.stats", sessionId: id }), value))
  const reading = () => stats.latest?.key === sessionId() ? stats.latest : undefined
  const data = () => reading()?.value
  const generation = createMemo(() => {
    const value = data()
    return value ? generationSpeedLines(value.generation) : undefined
  })
  const error = () => reading()?.error
  const scroll = createModalScrollController()
  const overall = () => host.navigate.openSurface(USAGE_SPEND_SURFACE)
  let entry: ModalHandle | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const refresh = () => { if (sessionId() && !stats.loading) void refetch() }
  const close = () => entry?.close()
  const status = () => {
    const current = data()
    if (stats.loading) return current ? "Refreshing..." : "Loading statistics..."
    return current ? `As of ${new Date(current.asOf).toLocaleTimeString()}` : ""
  }
  const cleanup = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
    entry = undefined
    setSessionId(undefined)
    mutate(undefined)
    scroll.detach()
  }
  onCleanup(() => { close(); cleanup() })

  function StatsModal() {
    const { termWidth, termHeight } = useModalDimensions(96, 10, Number.MAX_SAFE_INTEGER)
    return <ModalFrame title={USAGE_STATS_COMMAND_NAME} width={computeModalWidth(termWidth(), 96)} onClose={close} gap={1}>
      <scrollbox ref={(element: ScrollBoxRenderable) => scroll.attach(element)} maxHeight={Math.max(1, termHeight() - 10)} viewportCulling={true} contentOptions={{ minHeight: 0 }}>
        <box flexDirection="column" gap={1}>
          <Show when={sessionId()} fallback={<text fg={theme.textMuted}>Open a session to see its statistics.</text>}>
            <text fg={theme.textMuted}>This session, including descendant work</text>
            <text fg={theme.textMuted}>{status()}</text>
            <Show when={error()}>{(message) => <text fg={theme.warning}>{`Could not read statistics: ${message()}`}</text>}</Show>
            <Show when={data()}>{(value) => <box flexDirection="column" gap={1}>
            <Show when={value().partial}><text fg={theme.warning}>Some historical statistics are unavailable. These are the available readings.</text></Show>
            <CostLine label="Total" summary={value().totals} />
            <UsageTokenLines tokens={value().totals.tokens} coverage={value().totals} />
            <text fg={theme.textMuted}>Cache hit rate is the share of reported input tokens served from cache. Writes are uncached input.</text>
            <CostLine label="This agent" summary={value().direct} />
            <CostLine label={`Descendant work (${value().descendantCount})`} summary={value().descendants} />
            <Show when={generation()}>{(speed) => <box flexDirection="column" gap={0}>
              <text fg={theme.text} attributes={BOLD}>Generation speed</text>
              <Key each={speed().rows} by="label">{(row) => <text fg={theme.text}>{`${row().label}\n${row().value}`}</text>}</Key>
              <For each={speed().coverageLines}>{(line) => <text fg={theme.textMuted}>{line}</text>}</For>
              <text fg={theme.textMuted}>{speed().basisLine}</text>
            </box>}</Show>
            <text fg={theme.text}>{`${value().tools.reduce((sum, tool) => sum + tool.calls, 0).toLocaleString("en-US")} tool calls · ${value().tools.reduce((sum, tool) => sum + tool.errors, 0).toLocaleString("en-US")} error outcomes`}</text>
            <Button label={`${modelsOpen() ? "Hide" : "Show"} models (${value().models.length})`} hotkey="m" muted onPress={() => setModelsOpen((open) => !open)} />
            <Show when={modelsOpen()}><Key each={value().models} by="model">{(model) => <box flexDirection="column" gap={0}>
              <text fg={theme.text} attributes={BOLD}>{model().model}</text>
              <CostLine label="Cost" summary={model()} />
              <UsageTokenLines tokens={model().tokens} coverage={model()} />
            </box>}</Key></Show>
            <Button label={`${toolsOpen() ? "Hide" : "Show"} tools (${value().tools.length})`} hotkey="t" muted onPress={() => setToolsOpen((open) => !open)} />
            <Show when={toolsOpen()}><Key each={value().tools} by="name">{(tool) => <box flexDirection="column">
              <text fg={theme.text}>{`${tool().name}  ${tool().calls.toLocaleString("en-US")} calls · ${tool().errors.toLocaleString("en-US")} errors`}</text>
              <Show when={tool().blocked + tool().cancelled + tool().interrupted + tool().stopped > 0}><text fg={theme.textMuted}>{`${tool().blocked} blocked · ${tool().cancelled} cancelled · ${tool().interrupted} interrupted · ${tool().stopped} stopped`}</text></Show>
            </box>}</Key></Show>
            </box>}</Show>
          </Show>
        </box>
      </scrollbox>
      <box flexDirection="row" gap={1}>
        <Button label="Overall usage" hotkey="u" onPress={overall} />
        <Button label={error() === undefined ? "Refresh" : "Retry"} hotkey="r" muted onPress={refresh} />
      </box>
      <text fg={theme.textMuted}>↑/↓ scroll · PgUp/PgDn page · esc close</text>
    </ModalFrame>
  }
  return () => {
    close()
    setModelsOpen(false); setToolsOpen(false); scroll.reset()
    entry = host.modal.replace(() => <StatsModal />, { onClose: cleanup, onKey: (event) => {
      const key = event.name.toLowerCase()
      if (key === "escape") close()
      else if (key === "r") refresh()
      else if (key === "u") overall()
      else if (key === "m") setModelsOpen((open) => !open)
      else if (key === "t") setToolsOpen((open) => !open)
      else if (key === "up" || key === "k") scroll.scrollBy(-1)
      else if (key === "down" || key === "j") scroll.scrollBy(1)
      else if (key === "pageup" || key === "pagedown") scroll.pageBy(key === "pageup" ? -1 : 1)
      else return
      event.preventDefault?.()
    } })
    setSessionId(host.foregroundId())
    timer = setInterval(refresh, 2_000)
  }
}

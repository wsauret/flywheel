/** @jsxImportSource @opentui/solid */

import type { Accessor, JSX } from "solid-js"
import { createEffect, createMemo, createSignal, on, onCleanup, Show, untrack } from "solid-js"
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"
import { formatCostSplit, formatDuration, formatTokens } from "../../protocol/client/format.js"
import type { SessionCatalogRow } from "../../protocol/app-service-types.js"
import type { DiffColorMode } from "../../orchestration/config/schema.js"
import { TranscriptRows } from "../output-blocks/transcript-rows.js"
import { useTheme } from "../context/theme.js"
import { ScrollPreserveProvider } from "../context/scroll-preserve.js"
import { BlockDisclosureProvider, createBlockDisclosureChannel } from "../context/block-disclosure.js"
import type { SessionPreviewReader, SessionPreviewState } from "./use-session-preview.js"
import { createMountedRowRegistry, syncScrollExtent } from "../output-window/output-window-scroll.js"
import { patchScrollBoxLayoutHooks } from "../components/scrollbox-layout-hooks.js"
import { blockIdentity } from "../../protocol/block-identity.js"
import type { PresentedTerminalRow } from "../output-blocks/visible-output-blocks.js"

interface SessionPreviewPaneProps {
  readonly session?: SessionCatalogRow
  readonly preview: SessionPreviewState
  readonly width: number
  readonly height: number
  readonly showThinking?: boolean
  readonly diffColors?: Accessor<DiffColorMode>
  readonly onReader?: (reader: SessionPreviewReader | undefined) => void
}

const preservePreviewScroll = (fn: () => void): void => fn()

export function SessionPreviewPane(props: SessionPreviewPaneProps): JSX.Element {
  const { theme } = useTheme()
  const bodyHeight = createMemo(() => Math.max(1, Math.floor(props.height) - 4))
  const selectedSessionId = createMemo(() => props.session?.id ?? props.preview.sessionId)
  const header = createMemo(() => previewHeader(props.preview.status))
  const stats = createMemo(() => props.session ? sessionStats(props.session) : "No session selected")
  const borderColor = createMemo(() => props.preview.status === "loading" ? theme.primary : theme.borderSubtle)

  return (
    <box
      width={props.width}
      height={props.height}
      flexDirection="column"
      border={["top", "bottom", "left", "right"]}
      borderStyle="rounded"
      borderColor={borderColor()}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme.textMuted} overflow="hidden" wrapMode="none">{header()}</text>
      <text fg={theme.textMuted} overflow="hidden" wrapMode="none">{stats()}</text>
      <Show when={selectedSessionId()} keyed>
        {(_id) => <PreviewTranscript {...props} bodyHeight={bodyHeight()} />}
      </Show>
    </box>
  )
}

function PreviewTranscript(props: SessionPreviewPaneProps & { bodyHeight: number }): JSX.Element {
  const { theme } = useTheme()
  const disclosure = createBlockDisclosureChannel()
  const registry = createMountedRowRegistry()
  const rows = new Map<number, { el: BoxRenderable; block: Accessor<PresentedTerminalRow> }>()
  const [scrollbox, setScrollbox] = createSignal<ScrollBoxRenderable>()
  let nextKey = 0
  let anchor: { key: number; offset: number; text: ReturnType<typeof registry.captureText> } | undefined
  let placedOffset = 0
  let frameExtent = 0
  let viewportWidth = 0
  let viewportHeight = 0
  let initialized = false
  untrack(() => props.onReader?.(undefined))
  onCleanup(() => props.onReader?.(undefined))
  createEffect(on(scrollbox, scroll => {
    if (scroll) onCleanup(patchScrollBoxLayoutHooks(scroll, {
      onFrame: () => untrack(() => frame(scroll)),
      // OpenTUI can recalculate with cached, pre-layout heights after the frame correction.
      onBarsRecalculated: () => {
        if (!initialized) return
        scroll.verticalScrollBar.scrollSize = frameExtent
        scroll.scrollTo(placedOffset)
      },
    }))
  }))

  function frame(scroll: ScrollBoxRenderable): void {
    const ordered = [...rows.entries()].sort((a, b) => a[1].el.getLayout().top - b[1].el.getLayout().top)
    if (ordered.length === 0) return
    syncScrollExtent(scroll)
    if (scroll.content.height <= 0 || scroll.viewport.height <= 0) return
    const reflow = scroll.verticalScrollBar.scrollSize !== frameExtent || scroll.viewport.width !== viewportWidth || scroll.viewport.height !== viewportHeight
    frameExtent = scroll.verticalScrollBar.scrollSize
    if (!initialized) {
      scroll.scrollTo(Math.max(0, scroll.content.height - scroll.viewport.height))
      initialized = true
    } else if (anchor && (reflow || scroll.scrollTop === placedOffset)) {
      const top = rows.get(anchor.key)?.el.getLayout().top
      if (top !== undefined) scroll.scrollTo((anchor.text ? registry.resolveText(anchor.key, anchor.text) : undefined) ?? top + anchor.offset)
    } else anchor = undefined

    if (!anchor || !rows.has(anchor.key)) {
      const first = ordered.find(([, row]) => {
        const box = row.el.getLayout()
        return box.top + box.height > scroll.scrollTop
      })
      if (first) anchor = {
        key: first[0], offset: scroll.scrollTop - first[1].el.getLayout().top,
        text: registry.captureText(first[0], scroll.scrollTop),
      }
    }
    placedOffset = scroll.scrollTop
    viewportWidth = scroll.viewport.width
    viewportHeight = scroll.viewport.height
    const visible = ordered.flatMap(([, row]) => {
      const box = row.el.getLayout()
      if (box.top + box.height <= scroll.scrollTop || box.top >= scroll.scrollTop + scroll.viewport.height) return []
      const block = row.block()
      return block.kind === "toolRun" ? block.children.map(child => child.disclosureId ?? blockIdentity(child)) : [blockIdentity(block)]
    })
    if (visible.length > 0) {
      const blocks = props.preview.blocks
      const first = blocks.findIndex(block => blockIdentity(block) === visible[0])
      props.onReader?.({ kind: "residentSpan", blockIds: visible, candidates: blocks.slice(Math.max(0, first - 8), first).toReversed().map(blockIdentity) })
    }
  }

  return <Show when={props.preview.blocks.length > 0} fallback={
    <Show when={props.preview.status !== "idle"}>
      <box paddingTop={1}><text fg={theme.textMuted} wrapMode="word">{
        props.preview.status === "unavailable" ? props.preview.unavailable?.message ?? "Preview unavailable"
          : props.preview.status === "ready" ? "No messages to preview" : "Loading Preview…"
      }</text></box>
    </Show>
  }>
    <BlockDisclosureProvider value={disclosure}>
      <ScrollPreserveProvider value={preservePreviewScroll}>
        <scrollbox
          ref={setScrollbox}
          maxHeight={props.bodyHeight}
          viewportOptions={{ paddingRight: 1 }}
          verticalScrollbarOptions={{ paddingLeft: 1, trackOptions: { foregroundColor: theme.border, backgroundColor: theme.backgroundElement } }}
        >
          <TranscriptRows blocks={props.preview.blocks} streamingToolText={props.preview.streamingToolText}
            showThinking={props.showThinking} diffColors={props.diffColors} settled={true} historical={true}
            frameRow={(block, children) => {
              const key = nextKey++
              return <box flexDirection="column" ref={el => {
                rows.set(key, { el, block })
                const unregister = registry.register(el, () => key)
                onCleanup(() => { unregister(); rows.delete(key) })
              }}>{children}</box>
            }}
          />
        </scrollbox>
      </ScrollPreserveProvider>
    </BlockDisclosureProvider>
  </Show>
}

function previewHeader(status: SessionPreviewState["status"]): string {
  if (status === "loading") return "Loading Preview…"
  if (status === "unavailable") return "Preview Unavailable"
  return "Session Preview"
}

function sessionStats(session: SessionCatalogRow): string {
  if (session.totalsLoading) return ""
  const parts: string[] = []
  parts.push(formatDuration(session.durationMs))
  const cost = formatCostSplit(session.totalCost, session.totalBilledCost)
  if (cost) parts.push(`${cost}${session.priceUnavailable ? " · price unavailable" : ""}`)
  parts.push(`${formatTokens(session.totalTokens)} tokens`, `${formatContextPercent(session.contextPercent)} ctx`)
  return parts.join(" · ")
}

function formatContextPercent(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) return "0%"
  return `${Math.min(100, Math.round(percent))}%`
}


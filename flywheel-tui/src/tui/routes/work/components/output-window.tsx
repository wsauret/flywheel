/** @jsxImportSource @opentui/solid */
/**
 * Output Window Component
 *
 * Displays streaming workflow output with auto-scroll.
 * The prompt now lives outside OutputWindow as UnifiedPrompt.
 */

import { Show, Index, createSignal } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { ShimmerText } from "@tui/shared/components/shimmer-text"
import { Spinner } from "@tui/shared/components/spinner"
import { BlockRenderer } from "./output-blocks/block-renderer"
import type { WorkflowStatus, PhaseStatus, AnyBlock } from "../state/types"
import { getStatusIcon, getStatusColor } from "./status-utils"

const MIN_WIDTH_FOR_INLINE_STATUS = 75

export interface CurrentPhaseInfo {
  index: number
  name: string
  status: PhaseStatus
}

export interface OutputWindowProps {
  outputBlocks: AnyBlock[]
  workflowStatus: WorkflowStatus
  approvalPending: boolean
  isPromptFocused: boolean
  availableWidth?: number
  currentPhase?: CurrentPhaseInfo | null
}

export function OutputWindow(props: OutputWindowProps) {
  const themeCtx = useTheme()
  const [scrollRef, setScrollRef] = createSignal<ScrollBoxRenderable | undefined>()

  const isRunning = () => props.workflowStatus === "running"
  const hasContent = () => props.outputBlocks.length > 0
  const isWide = () => (props.availableWidth ?? 80) >= MIN_WIDTH_FOR_INLINE_STATUS
  const blockCountText = () => `${props.outputBlocks.length} blocks`

  const activityPhrase = () => {
    if (props.approvalPending) return "Waiting for approval..."
    if (props.currentPhase?.status === "running") return "Executing phase..."
    return null
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Rich Header (when phase is active) */}
      <Show when={props.currentPhase} fallback={
        /* Simple header: no active phase */
        <box flexDirection="column" paddingLeft={1} height={3} flexShrink={0}>
          <text fg={themeCtx.theme.border}>{"\u256D\u2500"}</text>
          <box flexDirection="row" justifyContent="space-between" paddingRight={2}>
            <box flexDirection="row">
              <text fg={themeCtx.theme.border}>{"\u2502  "}</text>
              <text fg={themeCtx.theme.text} attributes={1}>
                Output
              </text>
            </box>
            <text fg={themeCtx.theme.textMuted}>{blockCountText()}</text>
          </box>
          <text fg={themeCtx.theme.border}>{"\u2570\u2500"}</text>
        </box>
      }>
        {(phase) => {
          const statusColor = () => getStatusColor(phase().status, themeCtx.theme)

          return (
            <Show when={isWide()} fallback={
              /* Narrow layout: 5 lines */
              <box flexDirection="column" paddingLeft={1} height={5} flexShrink={0}>
                <text fg={themeCtx.theme.border}>{"\u256D\u2500"}</text>
                {/* Line 1: Phase name */}
                <box flexDirection="row">
                  <text fg={themeCtx.theme.border}>{"\u2502  "}</text>
                  <text fg={themeCtx.theme.text} attributes={1}>
                    Phase {phase().index + 1}: {phase().name}
                  </text>
                </box>
                {/* Line 2: Status icon */}
                <box flexDirection="row">
                  <text fg={themeCtx.theme.border}>{"\u2502  "}</text>
                  <Show when={phase().status === "running"} fallback={
                    <text fg={statusColor()}>{getStatusIcon(phase().status)} {phase().status}</text>
                  }>
                    <Spinner color={statusColor()} />
                    <text fg={statusColor()}> {phase().status}</text>
                  </Show>
                </box>
                {/* Line 3: Activity phrase + line count */}
                <box flexDirection="row" justifyContent="space-between" paddingRight={2}>
                  <box flexDirection="row">
                    <text fg={themeCtx.theme.border}>{"\u2502  "}</text>
                    <Show when={activityPhrase()} fallback={
                      <text fg={themeCtx.theme.textMuted}>{"\u21B3 "}{blockCountText()}</text>
                    }>
                      {(phrase) => (
                        <>
                          <text fg={themeCtx.theme.textMuted}>{"\u21B3 "}</text>
                          <ShimmerText text={phrase()} />
                        </>
                      )}
                    </Show>
                  </box>
                  <Show when={activityPhrase()}>
                    <text fg={themeCtx.theme.textMuted}>{blockCountText()}</text>
                  </Show>
                </box>
                <text fg={themeCtx.theme.border}>{"\u2570\u2500"}</text>
              </box>
            }>
              {/* Wide layout: 4 lines */}
              <box flexDirection="column" paddingLeft={1} height={4} flexShrink={0}>
                <text fg={themeCtx.theme.border}>{"\u256D\u2500"}</text>
                {/* Line 1: Phase name + status */}
                <box flexDirection="row" justifyContent="space-between" paddingRight={2}>
                  <box flexDirection="row">
                    <text fg={themeCtx.theme.border}>{"\u2502  "}</text>
                    <text fg={themeCtx.theme.text} attributes={1}>
                      Phase {phase().index + 1}: {phase().name}
                    </text>
                  </box>
                  <box flexDirection="row">
                    <Show when={phase().status === "running"} fallback={
                      <text fg={statusColor()}>{getStatusIcon(phase().status)} {phase().status}</text>
                    }>
                      <Spinner color={statusColor()} />
                      <text fg={statusColor()}> {phase().status}</text>
                    </Show>
                  </box>
                </box>
                {/* Line 2: Activity phrase + line count */}
                <box flexDirection="row" justifyContent="space-between" paddingRight={2}>
                  <box flexDirection="row">
                    <text fg={themeCtx.theme.border}>{"\u2502  "}</text>
                    <Show when={activityPhrase()} fallback={
                      <text fg={themeCtx.theme.textMuted}>{"\u21B3 "}</text>
                    }>
                      {(phrase) => (
                        <>
                          <text fg={themeCtx.theme.textMuted}>{"\u21B3 "}</text>
                          <ShimmerText text={phrase()} />
                        </>
                      )}
                    </Show>
                  </box>
                  <text fg={themeCtx.theme.textMuted}>{blockCountText()}</text>
                </box>
                <text fg={themeCtx.theme.border}>{"\u2570\u2500"}</text>
              </box>
            </Show>
          )
        }}
      </Show>

      {/* Content */}
      <box paddingLeft={1} paddingRight={1} flexDirection="column" flexGrow={1}>
        <Show when={!hasContent() && isRunning()}>
          <box flexDirection="row">
            <text fg={themeCtx.theme.text}>{"\u25CF "}</text>
            <ShimmerText text="Waiting for output..." />
          </box>
        </Show>

        <Show when={!hasContent() && !isRunning()}>
          <text fg={themeCtx.theme.textMuted}>No output</text>
        </Show>

        <Show when={hasContent()}>
          <scrollbox
            ref={(r: ScrollBoxRenderable) => setScrollRef(r)}
            flexGrow={1}
            width="100%"
            stickyScroll={true}
            stickyStart="bottom"
            scrollbarOptions={{
              showArrows: true,
              trackOptions: {
                foregroundColor: themeCtx.theme.info,
                backgroundColor: themeCtx.theme.borderSubtle,
              },
            }}
            viewportCulling={true}
            focused={!props.isPromptFocused}
          >
            <Index each={props.outputBlocks}>
              {(block) => <BlockRenderer block={block()} />}
            </Index>
          </scrollbox>
        </Show>
      </box>
    </box>
  )
}

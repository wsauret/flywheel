/** @jsxImportSource @opentui/solid */
/**
 * Phase Node Component
 *
 * Renders a single phase in the timeline with:
 * - Status icon (or spinner when running)
 * - Phase name with selection indicator
 * - Live duration via timer service
 * - Error display
 */

import { Show } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import { useTimer } from "@tui/shared/services"
import { Spinner } from "@tui/shared/components/spinner"
import type { PhaseState } from "../state/types"
import { getStatusIcon, getStatusColor } from "./status-utils"

export interface PhaseNodeProps {
  phase: PhaseState
  isSelected: boolean
  availableWidth?: number
}

export function PhaseNode(props: PhaseNodeProps) {
  const themeCtx = useTheme()
  const timer = useTimer()

  const color = () =>
    props.phase.error
      ? themeCtx.theme.error
      : getStatusColor(props.phase.status, themeCtx.theme)

  const duration = () => {
    if (props.phase.duration !== undefined) {
      // Phase completed near-instantly (< 1s) — show "done" instead of "00:00"
      if (props.phase.duration < 1 && props.phase.status === "completed") {
        return "done"
      }
      const s = Math.max(0, Math.floor(props.phase.duration))
      const m = Math.floor(s / 60)
      const sec = s % 60
      return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`
    }
    if (props.phase.status === "running") {
      return timer.agentDuration(`phase-${props.phase.index}`)
    }
    return ""
  }

  const selectionPrefix = () => (props.isSelected ? "> " : "  ")

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" overflow="hidden">
        <text wrapMode="none" fg={themeCtx.theme.text}>
          {selectionPrefix()}
        </text>
        <Show
          when={props.phase.status === "running"}
          fallback={
            <text wrapMode="none" fg={color()}>
              {getStatusIcon(props.phase.status)}{" "}
            </text>
          }
        >
          <Spinner color={color()} />
          <text wrapMode="none"> </text>
        </Show>
        <text wrapMode="none" fg={themeCtx.theme.text} attributes={1}>
          Phase {props.phase.index + 1}: {props.phase.name}
        </text>
        <Show when={duration()}>
          <text wrapMode="none" fg={themeCtx.theme.textMuted}>
            {" "}
            &bull; {duration()}
          </text>
        </Show>
      </box>
      <Show when={props.phase.error}>
        <box paddingLeft={4}>
          <text fg={themeCtx.theme.error}>{"\u2717"} {props.phase.error}</text>
        </box>
      </Show>
    </box>
  )
}

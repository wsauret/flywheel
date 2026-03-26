/** @jsxImportSource @opentui/solid */
/**
 * Phase Progress Component
 *
 * Displays the phase timeline as a scrollable list.
 * Simplified from CodeMachine's agent-timeline (no sub-agents, separators, expand/collapse).
 */

import { For, Show } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import { PhaseNode } from "./phase-node"
import type { PhaseState } from "../state/types"

export interface PhaseProgressProps {
  phases: PhaseState[]
  selectedIndex: number
  availableWidth?: number
  stepLabel?: string  // "Step" | "Cycle" — defaults to "Step"
}

export function PhaseProgress(props: PhaseProgressProps) {
  const themeCtx = useTheme()

  return (
    <box flexDirection="column" width="100%">
      <box paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1}>
        <text fg={themeCtx.theme.text} attributes={1}>
          {props.stepLabel ?? "Step"} Progress ({props.phases.length} {props.phases.length === 1 ? (props.stepLabel?.toLowerCase() ?? "step") : (props.stepLabel?.toLowerCase() ?? "step") + "s"})
        </text>
      </box>

      <Show
        when={props.phases.length > 0}
        fallback={
          <box paddingLeft={1}>
            <text fg={themeCtx.theme.textMuted}>No steps yet.</text>
          </box>
        }
      >
        <scrollbox
          flexGrow={1}
          scrollbarOptions={{ visible: false }}
          viewportCulling={true}
        >
          <For each={props.phases}>
            {(phase) => (
              <PhaseNode
                phase={phase}
                isSelected={phase.index === props.selectedIndex}
                availableWidth={props.availableWidth}
              />
            )}
          </For>
        </scrollbox>
      </Show>
    </box>
  )
}

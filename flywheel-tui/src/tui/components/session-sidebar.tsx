/** @jsxImportSource @opentui/solid */
/**
 * Session Sidebar Component
 *
 * Displays sessions grouped by lifecycle state: Active, Paused, Other,
 * Archived, Trash. Supports keyboard navigation (up/down, enter to select).
 *
 * Collapsible: hidden when terminal width < 90 columns.
 *
 * Active session row reads from live store; historical sessions from
 * SessionSummary (plain data, no live store/adapter).
 */

import { createMemo, createSignal, For, Show } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import {
  groupSessions,
  sidebarKeyHandler,
  GROUP_ORDER,
  GROUP_LABELS,
  type SessionGroupKey,
  type SelectionAction,
} from "./sidebar-logic"
import { SIDEBAR_WIDTH } from "./shell-modes"
import type { SessionSummary } from "../../session/manager"

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SessionSidebarProps {
  /** All sessions to display. */
  sessions: SessionSummary[]
  /** Available terminal width — sidebar hides below 90. */
  terminalWidth?: number
  /** Sidebar width in columns. */
  width?: number
  /** Called when a session is selected. */
  onSelect?: (sessionId: string, action: SelectionAction) => void
  /** Called when "+" button is activated (open starter chooser). */
  onNewSession?: () => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SessionSidebar(props: SessionSidebarProps) {
  const themeCtx = useTheme()
  const [selectedIndex, setSelectedIndex] = createSignal(0)

  const width = () => props.width ?? SIDEBAR_WIDTH

  // Collapse when terminal is too narrow
  const isVisible = () => (props.terminalWidth ?? 120) >= 90

  const groups = () => groupSessions(props.sessions)

  // Build flat list for navigation context
  const flatList = () => {
    const g = groups()
    const flat: SessionSummary[] = []
    for (const key of GROUP_ORDER) {
      flat.push(...g[key])
    }
    return flat
  }

  // O(1) index lookup per session row (replaces O(n) findIndex per row)
  const flatIndexMap = createMemo(() =>
    new Map(flatList().map((s, i) => [s.id, i]))
  )

  const handleKeyDown = () => {
    const result = sidebarKeyHandler("move-down", props.sessions, selectedIndex())
    setSelectedIndex(result.selectedIndex)
  }

  const handleKeyUp = () => {
    const result = sidebarKeyHandler("move-up", props.sessions, selectedIndex())
    setSelectedIndex(result.selectedIndex)
  }

  const handleSelect = () => {
    const result = sidebarKeyHandler("select", props.sessions, selectedIndex())
    if (result.selectedSessionId && result.action && props.onSelect) {
      props.onSelect(result.selectedSessionId, result.action)
    }
  }

  const handleDelete = () => {
    const result = sidebarKeyHandler("delete", props.sessions, selectedIndex())
    if (result.selectedSessionId && result.action && props.onSelect) {
      props.onSelect(result.selectedSessionId, result.action)
    }
  }

  return (
    <Show when={isVisible()}>
      <box
        flexDirection="column"
        width={width()}
        height="100%"
        borderStyle="single"
        borderColor={themeCtx.theme.border}
      >
        {/* Header */}
        <box paddingLeft={1} paddingRight={1} flexShrink={0}>
          <text fg={themeCtx.theme.text} attributes={1}>
            Sessions
          </text>
        </box>

        {/* Session groups */}
        <scrollbox flexGrow={1} scrollbarOptions={{ visible: false }}>
          <For each={GROUP_ORDER.filter((key) => groups()[key].length > 0)}>
            {(groupKey) => (
              <box flexDirection="column">
                {/* Group label */}
                <box paddingLeft={1}>
                  <text fg={themeCtx.theme.textMuted}>
                    {GROUP_LABELS[groupKey]}
                  </text>
                </box>

                {/* Session rows */}
                <For each={groups()[groupKey]}>
                  {(session) => {
                    const flatIdx = () => flatIndexMap().get(session.id) ?? -1
                    const isSelected = () => flatIdx() === selectedIndex()

                    return (
                      <box paddingLeft={2}>
                        <text
                          fg={isSelected() ? themeCtx.theme.background : themeCtx.theme.text}
                          bg={isSelected() ? themeCtx.theme.primary : undefined}
                        >
                          {truncate(session.name || session.planPath, width() - 4)}
                        </text>
                      </box>
                    )
                  }}
                </For>
              </box>
            )}
          </For>
        </scrollbox>
      </box>
    </Show>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(text: string, maxLen: number): string {
  if (maxLen < 4) return text.slice(0, maxLen)
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 1) + "\u2026"
}

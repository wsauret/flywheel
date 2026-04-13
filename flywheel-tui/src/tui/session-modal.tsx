/** @jsxImportSource @opentui/solid */
/**
 * SessionModal — Full-screen overlay for browsing, resuming, and deleting sessions.
 *
 * Pure display component. Keyboard handling lives in the shell's useKeyboard
 * (which reliably receives all events). The shell drives cursor and actions
 * via props.
 *
 * Opens via `/sessions` or Ctrl+B.
 * Groups sessions by state: Active, Paused, Completed.
 */

import { createMemo, createSignal, createEffect, For, Show, untrack, on } from "solid-js"
import { createTextAttributes } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { useSession } from "@tui/shared/context/session"
import { ModalBase } from "@tui/shared/components/modal/modal-base"
import { isResumable } from "../orchestration/session/state-machine"
import { truncate } from "./utils/text"
import { formatCost, formatTokens, relativeTime } from "../infra/format.js"
import type { SessionSummary } from "../orchestration/session/manager"
import type { SessionState } from "../orchestration/session/state-machine"

// Props

export interface SessionModalProps {
  activeSessionId?: string
  cursor: number
  confirmDeleteId?: string
  /** Monotonically increasing counter — bump to refresh the session list snapshot. */
  refreshTrigger?: number
  onClose: () => void
  onSelect: (flatIndex: number) => void
}

// Helpers (exported for shell keyboard handler)

type GroupKey = "active" | "paused" | "completed"

const GROUP_ORDER: GroupKey[] = ["active", "paused", "completed"]

const GROUP_LABELS: Record<GroupKey, string> = {
  active: "Active",
  paused: "Paused",
  completed: "Completed",
}

const GROUP_ICONS: Record<GroupKey, string> = {
  active: "\u25CF",
  paused: "\u2759",
  completed: "\u2713",
}

const STATE_TO_GROUP: Record<SessionState, GroupKey> = {
  active: "active",
  paused: "paused",
  completed: "completed",
}

/** Build flat session list from reactive sessions signal. Exported for shell use. */
export function buildSessionList(sessions: SessionSummary[]): { session: SessionSummary; group: GroupKey }[] {
  const items: { session: SessionSummary; group: GroupKey }[] = []
  const groups: Record<GroupKey, SessionSummary[]> = {
    active: [], paused: [], completed: [],
  }

  for (const s of sessions) {
    const group = STATE_TO_GROUP[s.state]
    if (group) groups[group].push(s)
  }

  for (const key of GROUP_ORDER) {
    groups[key].sort(
      (a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime(),
    )
    for (const s of groups[key]) {
      items.push({ session: s, group: key })
    }
  }

  return items
}

// Component

export function SessionModal(props: SessionModalProps) {
  const { theme } = useTheme()
  const { sessions } = useSession()

  // ADR-006 deviation: signal-inside-effect. A createMemo won't work here
  // because we need to *snapshot* sessions() only when refreshTrigger bumps,
  // not re-derive on every sessions() change. Reactive updates from the
  // background 5s poll cause terminal corruption (overlapping list items).
  // The on()+defer pattern is the correct Solid idiom for event-triggered snapshots.
  const initialSessions = untrack(() => sessions())
  const [snapshotSessions, setSnapshotSessions] = createSignal(initialSessions)
  createEffect(on(() => props.refreshTrigger, () => {
    setSnapshotSessions(sessions())
  }, { defer: true }))
  const flatList = createMemo(() => buildSessionList(snapshotSessions()))

  const groupedSections = createMemo(() => {
    const items = flatList()
    const sections: { group: GroupKey; label: string; icon: string; items: { session: SessionSummary; flatIndex: number }[] }[] = []
    let currentGroup: GroupKey | null = null
    let currentSection: (typeof sections)[0] | null = null

    for (let i = 0; i < items.length; i++) {
      const { group } = items[i]
      if (group !== currentGroup) {
        currentGroup = group
        currentSection = { group, label: GROUP_LABELS[group], icon: GROUP_ICONS[group], items: [] }
        sections.push(currentSection)
      }
      currentSection!.items.push({ session: items[i].session, flatIndex: i })
    }

    return sections
  })

  const selectedSession = createMemo(() => {
    const items = flatList()
    const idx = props.cursor
    return idx >= 0 && idx < items.length ? items[idx].session : undefined
  })

  const footerText = createMemo(() => {
    const s = selectedSession()
    if (!s) return "[Esc] Close"
    const actions: string[] = []
    if (s.state === "active") actions.push("[Enter] Switch")
    else if (isResumable(s.state)) actions.push("[Enter/R] Resume")
    else actions.push("[Enter] View")
    if (s.id !== props.activeSessionId) actions.push("[D] Delete")
    return `\u2191\u2193 Navigate  ${actions.join("  ")}  [Esc] Close`
  })

  return (
    <ModalBase maxWidth={72}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.primary} attributes={1}>Sessions</text>
        <box onMouseDown={props.onClose}>
          <text fg={theme.textMuted}>[X]</text>
        </box>
      </box>

      <box paddingTop={1} paddingBottom={0} flexDirection="column">
        <Show when={flatList().length === 0}>
          <box paddingTop={1} paddingBottom={1}>
            <text fg={theme.textMuted}>No sessions yet. Try /sprint "desc" or /work "desc"</text>
          </box>
        </Show>

        <scrollbox
          maxHeight={18}
          viewportOptions={{
            paddingRight: 1,
          }}
          verticalScrollbarOptions={{
            paddingLeft: 1,
            trackOptions: {
              foregroundColor: theme.border,
              backgroundColor: theme.backgroundElement,
            },
          }}
        >
          <For each={groupedSections()}>
            {(section) => (
              <box flexDirection="column">
                <box paddingTop={section.group === "active" ? 0 : 1}>
                  <text fg={theme.textMuted} attributes={createTextAttributes({ bold: true })}>
                    {section.icon} {section.label} ({section.items.length})
                  </text>
                </box>

                <For each={section.items}>
                  {(item) => {
                    const isSelected = () => props.cursor === item.flatIndex
                    const isActive = () => item.session.id === props.activeSessionId
                    const label = () => truncate(item.session.label || item.session.name || item.session.id.slice(0, 8), 34)
                    const isDeletePending = () => props.confirmDeleteId === item.session.id
                    const typeTag = () => item.session.kind === "chat" ? "chat" : item.session.command
                    const typeColor = () => item.session.kind === "chat" ? theme.info : theme.accent

                    return (
                      <box
                        backgroundColor={isSelected() ? theme.backgroundElement : undefined}
                        paddingLeft={2}
                        paddingRight={1}
                        onMouseDown={() => props.onSelect(item.flatIndex)}
                      >
                        <box flexDirection="row" justifyContent="space-between">
                          <box flexDirection="row" gap={1}>
                            <text fg={isActive() ? theme.primary : theme.text}>
                              {isActive() ? "\u25B8" : " "}
                            </text>
                            <text fg={typeColor()}>{typeTag()}</text>
                            <text fg={isActive() ? theme.primary : theme.text}>{label()}</text>
                          </box>
                          <box flexDirection="row" gap={1} flexShrink={0}>
                            <Show when={item.session.totalTokens > 0}>
                              <text fg={theme.textMuted}>{formatTokens(item.session.totalTokens)}</text>
                            </Show>
                            <Show when={item.session.totalCost > 0}>
                              <text fg={theme.textMuted}>{formatCost(item.session.totalCost)}</text>
                            </Show>
                            <Show when={item.session.lastUpdated}>
                              <text fg={theme.textMuted}>{relativeTime(item.session.lastUpdated)}</text>
                            </Show>
                          </box>
                        </box>

                        <Show when={isDeletePending() && isSelected()}>
                          <text fg={theme.warning}>Press d again to confirm delete</text>
                        </Show>
                      </box>
                    )
                  }}
                </For>
              </box>
            )}
          </For>
        </scrollbox>
      </box>

      <box paddingTop={1} flexDirection="row" justifyContent="center">
        <text fg={theme.textMuted}>{footerText()}</text>
      </box>
    </ModalBase>
  )
}

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

import { BOLD } from "@tui/shared/ui/text-attributes"
import { StyledText, fg as stFg, bold as stBold, type TextChunk } from "@opentui/core"
import type { TextRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/shared/context/theme"
import { useSession } from "@tui/shared/context/session"
import { isResumable } from "../orchestration/session/types.js"
import { truncate } from "./utils/text.js"
import { formatCost, formatTokens, relativeTime } from "../infra/format.js"
import { buildSessionList } from "./hooks/use-session-modal.js"
import type { SessionState } from "../orchestration/session/types.js"
import type { SessionSummary } from "../orchestration/session/manager.js"

interface SessionModalProps {
  activeSessionId?: string
  cursor: number
  confirmDeleteId?: string
  /** Monotonically increasing counter — bump to refresh the session list snapshot. */
  refreshTrigger?: number
  onClose: () => void
  onSelect: (flatIndex: number) => void
}

const GROUP_LABELS: Record<SessionState, string> = {
  active: "Active",
  paused: "Paused",
  completed: "Completed",
}

const GROUP_ICONS: Record<SessionState, string> = {
  active: "\u25CF",
  paused: "\u2759",
  completed: "\u2713",
}

export function SessionModal(props: SessionModalProps) {
  const { theme } = useTheme()
  const { sessions } = useSession()

  // ADR-006 deviation: signal-inside-effect. Snapshot sessions() on open,
  // refresh only when refreshTrigger bumps (after delete). A createMemo would
  // re-derive on every sessions() change — background workflow completions
  // would shift the list while the user navigates with arrow keys.
  const initialSessions = untrack(() => sessions())
  const [snapshotSessions, setSnapshotSessions] = createSignal(initialSessions)
  createEffect(on(() => props.refreshTrigger, () => {
    setSnapshotSessions(sessions())
  }, { defer: true }))
  const flatList = createMemo(() => buildSessionList(snapshotSessions()))

  const groupedSections = createMemo(() => {
    const items = flatList()
    const sections: { group: SessionState; label: string; icon: string; items: { session: SessionSummary; flatIndex: number }[] }[] = []
    let currentGroup: SessionState | null = null
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
    if (!s) return "Esc close"
    const actions: string[] = []
    if (s.state === "active") actions.push("Enter switch")
    else if (isResumable(s.state)) actions.push("Enter view \u00b7 R resume")
    else actions.push("Enter view")
    actions.push("C copy id")
    if (s.id !== props.activeSessionId) actions.push("D delete")
    return `\u2191\u2193 navigate \u00b7 ${actions.join(" \u00b7 ")} \u00b7 Esc close`
  })

  const dimensions = useTerminalDimensions()
  const termWidth = () => dimensions()?.width ?? 80
  const termHeight = () => {
    const h = dimensions()?.height ?? 24
    return isFinite(h) && h > 0 ? h : 24
  }
  const modalWidth = () => Math.min(72, termWidth() - 4)

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={termWidth()}
      height={termHeight()}
      backgroundColor={theme.backdrop}
      alignItems="center"
      justifyContent="center"
      zIndex={2000}
    >
      <box
        flexDirection="column"
        backgroundColor={theme.background}
        borderColor={theme.primary}
        border={["top", "bottom", "left", "right"]}
        borderStyle="rounded"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        width={modalWidth()}
      >
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.primary} attributes={BOLD}>Sessions</text>
        <box onMouseDown={props.onClose}>
          <text fg={theme.textMuted}>×</text>
        </box>
      </box>

      <box paddingTop={1} paddingBottom={1} flexDirection="column">
        <Show when={flatList().length === 0}>
          <box paddingTop={1} paddingBottom={1}>
            <text ref={(el: TextRenderable) => {
              el.content = new StyledText([
                stFg(theme.textMuted)("No sessions yet. Try "),
                stFg(theme.secondary)("/sprint"),
                stFg(theme.textMuted)(" or "),
                stFg(theme.secondary)("/work"),
              ])
            }} />
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
                  <text ref={(el: TextRenderable) => {
                    const iconColor = section.group === "active" ? theme.primary : section.group === "paused" ? theme.warning : theme.successMuted
                    el.content = new StyledText([
                      stBold(stFg(iconColor)(section.icon)),
                      stBold(stFg(theme.textMuted)(` ${section.label} (${section.items.length})`)),
                    ])
                  }} />
                </box>

                <For each={section.items}>
                  {(item) => {
                    const isSelected = () => props.cursor === item.flatIndex
                    const isActive = () => item.session.id === props.activeSessionId
                    const label = () => truncate(item.session.label || item.session.name || item.session.id, 34)
                    const isDeletePending = () => props.confirmDeleteId === item.session.id
                    const typeTag = () => item.session.kind === "chat" ? "chat" : item.session.command
                    const typeColor = () => item.session.kind === "chat" ? theme.info : theme.accent


                    const metadata = [
                      item.session.totalTokens > 0 && formatTokens(item.session.totalTokens),
                      item.session.totalCost > 0 && formatCost(item.session.totalCost),
                      item.session.lastUpdated && relativeTime(item.session.lastUpdated),
                    ].filter(Boolean).join(" ")

                    return (
                      <box
                        backgroundColor={isSelected() ? theme.backgroundElement : undefined}
                        paddingLeft={2}
                        paddingRight={1}
                        onMouseDown={() => props.onSelect(item.flatIndex)}
                      >
                        <box flexDirection="row" justifyContent="space-between">
                          <box flexShrink={1} overflow="hidden">
                            <text ref={(el: TextRenderable) => {
                              createEffect(() => {
                                const cursorColor = isSelected() ? theme.primary : isActive() ? theme.primary : theme.textMuted
                                const cursor = isSelected() ? "\u25B8" : isActive() ? "\u25CF" : " "
                                el.content = new StyledText([
                                  stFg(cursorColor)(cursor),
                                  stFg(typeColor())(` ${typeTag()}`),
                                  stFg(isActive() ? theme.primary : theme.text)(` ${label()}`),
                                ])
                              })
                            }} overflow="hidden" wrapMode="none" />
                          </box>
                          <Show when={metadata}>
                            <text fg={theme.textMuted} flexShrink={0}>{metadata}</text>
                          </Show>
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

      <Show when={selectedSession()}>
        <box paddingTop={1} flexDirection="row" justifyContent="center">
          <text fg={theme.textSubtle}>Session ID: {selectedSession()!.id}</text>
        </box>
      </Show>

      <box paddingTop={1} flexDirection="row" justifyContent="center">
        <text fg={theme.textMuted}>{footerText()}</text>
      </box>
      </box>
    </box>
  )
}

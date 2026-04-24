/** @jsxImportSource @opentui/solid */
import { createMemo, createEffect, For, Show } from "solid-js"

import { BOLD } from "@tui/shared/ui/text-attributes"
import { StyledText, fg as stFg, bold as stBold, type TextChunk } from "@opentui/core"
import type { TextRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/shared/context/theme"

import { isResumable } from "../orchestration/session/types.js"
import { truncate } from "./utils/text.js"
import { formatCost, formatTokens, relativeTime } from "../infra/format.js"

import type { SessionState } from "../orchestration/session/types.js"
import type { SessionSummary } from "../orchestration/session/manager.js"

interface SessionModalProps {
  sessions: SessionSummary[]
  activeSessionId?: string
  cursor: number
  confirmDeleteId?: string
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

const GROUP_ORDER: SessionState[] = ["active", "paused", "completed"]

/** Flatten sessions into a grouped, recency-sorted list for cursor navigation and rendering. */
export function buildSessionList(sessions: SessionSummary[]): { session: SessionSummary; group: SessionState }[] {
  const groups: Record<SessionState, SessionSummary[]> = { active: [], paused: [], completed: [] }
  for (const s of sessions) groups[s.state].push(s)
  return GROUP_ORDER.flatMap((group) =>
    groups[group]
      .sort((a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime())
      .map((session) => ({ session, group })),
  )
}

export function SessionModal(props: SessionModalProps) {
  const { theme } = useTheme()

  const flatList = createMemo(() => buildSessionList(props.sessions))

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
        <box selectable={false} onMouseDown={props.onClose}>
          <text selectable={false} fg={theme.textMuted}>×</text>
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
                        selectable={false}
                        backgroundColor={isSelected() ? theme.backgroundElement : undefined}
                        paddingLeft={2}
                        paddingRight={1}
                        onMouseDown={() => props.onSelect(item.flatIndex)}
                      >
                        <text selectable={false} ref={(el: TextRenderable) => {
                          createEffect(() => {
                            const cursorColor = isSelected() ? theme.primary : isActive() ? theme.primary : theme.textMuted
                            const cursor = isSelected() ? "\u25B8" : isActive() ? "\u25CF" : " "
                            const leftLabel = `${cursor} ${typeTag()} ${label()}`
                            // Row's usable width = modalWidth() minus modal border/padding (4) and row left/right padding (3).
                            const rowWidth = Math.max(modalWidth() - 7, leftLabel.length)
                            const padding = " ".repeat(Math.max(1, rowWidth - leftLabel.length - metadata.length))
                            const chunks: TextChunk[] = [
                              stFg(cursorColor)(cursor),
                              stFg(typeColor())(` ${typeTag()}`),
                              stFg(isActive() ? theme.primary : theme.text)(` ${label()}`),
                            ]
                            if (metadata) {
                              chunks.push(stFg(theme.textMuted)(`${padding}${metadata}`))
                            }
                            el.content = new StyledText(chunks)
                          })
                        }} overflow="hidden" wrapMode="none" />

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

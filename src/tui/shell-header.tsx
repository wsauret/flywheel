/** @jsxImportSource @opentui/solid */
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { bindStyledTextContent } from "@tui/utils/reactive-text"
import { ContextControl } from "./components/context-control.js"
import { TabsBar } from "./components/tabs-bar.js"
import { createHeaderDisplay } from "./hooks/create-header-display.js"
import { useShellState } from "./hooks/shell-state.js"
import type { ChatModeHook } from "./hooks/use-chat-mode.js"
import type { ShellPlaces } from "./shell-navigation.js"

/** The header: the tabs, and the foreground chat's statistics with its
 *  context gauge, which compacts the conversation on a click. */
export function ShellHeader(props: { readonly places: ShellPlaces; readonly chat: Pick<ChatModeHook, "compactConversation"> }) {
  const { signals } = useShellState()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const { headerStats, contextCopy } = createHeaderDisplay({
    signals,
    dimensions,
    compactionThreshold: () => signals.display.compactionThreshold,
    theme,
  })
  const tabsAvailableWidth = createMemo(() => Math.max(0, dimensions().width - headerStats().width - 2))
  return (
    <box flexShrink={0} flexDirection="column">
      <box flexDirection="row">
        <box width={1} flexShrink={0} />
        <box flexGrow={1} overflow="hidden" flexShrink={1}>
          <TabsBar tabs={props.places.tabs} availableWidth={tabsAvailableWidth} theme={theme} onActivate={props.places.switchForeground} onNewTab={() => { void props.places.startChat() }} onReorder={props.places.reorderTab} />
        </box>
        <box flexDirection="column">
          <box height={1} />
          <box position="relative" height={1}>
            <text ref={bindStyledTextContent(() => headerStats().content)} overflow="hidden" wrapMode="none" />
            <Show when={headerStats().context}>
              {(context) =>
              <Show when={signals.foregroundId()} keyed>
                <ContextControl overlayLeft={context().left} label={context().label} color={context().color} copy={contextCopy()}
                  compacting={signals.compactionStartedAt() !== null} onCompact={props.chat.compactConversation} />
              </Show>
              }
            </Show>
          </box>
          <text
            fg={theme.text}
            overflow="hidden"
            wrapMode="none"
          >{"─".repeat(headerStats().width)}</text>
        </box>
        <box width={1} flexShrink={0} />
      </box>
    </box>
  )
}

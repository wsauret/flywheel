/** @jsxImportSource @opentui/solid */
/**
 * Empty State Component
 *
 * Fallback UI shown when the chat session fails to start (e.g., missing
 * ANTHROPIC_API_KEY). Since the TUI boots directly into chat mode, this
 * component only renders when that initialization fails and the app falls
 * back to idle state.
 *
 * Shows: FULL_LOGO, version, HOME_HELP_COMMANDS help rows, random slogan,
 * plus a hint about setting the API key to enable chat mode.
 * Centered vertically and horizontally in available space.
 */

import { For } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import { FULL_LOGO } from "@tui/shared/components/logo"
import { HOME_HELP_COMMANDS } from "@tui/commands"

const SLOGANS = [
  "plan  -  execute  -  iterate",
  "Your backlog called. We answered.",
  "Ship now. Apologize never.",
  "Born to plan. Forced to debug.",
  "The agents are talking. You're not invited.",
  "Deploying minions. Stand back.",
  "Refactoring your sins at 3AM.",
]

const getRandomSlogan = () => SLOGANS[Math.floor(Math.random() * SLOGANS.length)]

export function EmptyState() {
  const themeCtx = useTheme()
  const slogan = getRandomSlogan()

  return (
    <box
      flexGrow={1}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      gap={0}
    >
      {/* ASCII Logo */}
      <box flexDirection="column" alignItems="flex-start">
        <For each={FULL_LOGO}>
          {(line) => (
            <text fg={themeCtx.theme.primary}>{line}</text>
          )}
        </For>
      </box>

      {/* Version */}
      <box marginTop={1} marginBottom={1}>
        <text fg={themeCtx.theme.textMuted}>v0.0.1</text>
      </box>

      {/* API key hint — this is the idle fallback when chat can't start */}
      <box marginBottom={1}>
        <text fg={themeCtx.theme.warning}>
          Set ANTHROPIC_API_KEY to enable chat mode
        </text>
      </box>

      {/* Help rows for top commands */}
      <box width={60} flexDirection="column" gap={0}>
        <For each={HOME_HELP_COMMANDS}>
          {(cmd) => (
            <box flexDirection="row" gap={2}>
              <box width={14}>
                <text fg={themeCtx.theme.primary}>{cmd.name}</text>
              </box>
              <box>
                <text fg={themeCtx.theme.textMuted}>{cmd.description}</text>
              </box>
            </box>
          )}
        </For>
      </box>

      {/* Slogan */}
      <box marginTop={1}>
        <text fg={themeCtx.theme.textMuted}>{slogan}</text>
      </box>
    </box>
  )
}

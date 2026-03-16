/** @jsxImportSource @opentui/solid */
/**
 * Welcome Section Component
 *
 * Displays logo, version, slogans, and help rows for top commands.
 */

import { For } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import { FULL_LOGO } from "@tui/shared/components/logo"
import { HelpRow } from "./help-row"
import { HOME_HELP_COMMANDS } from "@tui/config/commands"

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

export function WelcomeSection() {
  const themeCtx = useTheme()
  const slogan = getRandomSlogan()

  return (
    <>
      {/* ASCII Logo */}
      <box flexDirection="column" alignItems="center">
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

      {/* Help rows for top commands */}
      <box width={60} flexDirection="column" gap={0}>
        <For each={HOME_HELP_COMMANDS}>
          {(cmd) => (
            <HelpRow command={cmd.name} description={cmd.description} />
          )}
        </For>
      </box>

      {/* Slogan */}
      <box marginTop={1}>
        <text fg={themeCtx.theme.textMuted}>{slogan}</text>
      </box>
    </>
  )
}

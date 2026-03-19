/**
 * Command Parser
 *
 * Parses user input from the prompt into a structured command result.
 * Used by FlywheelShell and tested independently.
 *
 * **Derived from COMMANDS** — adding a new slash command to `commands.ts`
 * automatically makes it available here. The `argKey` field on each command
 * determines how trailing text is mapped into `args`.
 */

import { COMMAND_MAP } from "../config/commands"

export interface CommandResult {
  workflow: string
  args: Record<string, string>
}

/**
 * Parse prompt input into a CommandResult.
 *
 * - `/work <path>` -> { workflow: "work", args: { planPath: path } }
 * - `/plan <description>` -> { workflow: "plan", args: { description } }
 * - `/review` -> { workflow: "review", args: {} }
 * - `/ship` -> { workflow: "ship", args: {} }
 * - `/debug <description>` -> { workflow: "debug", args: { description } }
 * - `/research <topic>` -> { workflow: "research", args: { topic } }
 * - `/config` -> { workflow: "config", args: {} }
 * - `/exit` -> { workflow: "exit", args: {} }
 * - `/help` -> { workflow: "help", args: {} }
 * - `/new` -> { workflow: "new", args: {} }
 * - Bare text (no `/`) -> null (must use a slash command)
 * - Unknown `/command` -> null
 * - Empty string -> null
 */
export function parseCommand(input: string): CommandResult | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // Non-slash input: require a slash command
  if (!trimmed.startsWith("/")) {
    return null
  }

  // Parse slash command: "/command rest..."
  const spaceIndex = trimmed.indexOf(" ")
  const rawCommand =
    spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex)
  const rest =
    spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim()

  const command = rawCommand.toLowerCase()

  // Look up command in the derived map (single source of truth)
  const def = COMMAND_MAP.get(command)
  if (!def) return null

  // Build args from the argKey (if any)
  const args: Record<string, string> =
    def.argKey && rest ? { [def.argKey]: rest } : {}

  return { workflow: command, args }
}

/**
 * @deprecated Use `parseCommand` instead. This alias exists for backward compatibility.
 */
export const parseHomeCommand = parseCommand

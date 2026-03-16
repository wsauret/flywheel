/**
 * Home Command Parser
 *
 * Parses user input from the home screen prompt into a structured command result.
 * Used by HomeView and tested independently.
 */

export interface CommandResult {
  workflow: string
  args: Record<string, string>
}

/**
 * Parse home screen input into a CommandResult.
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
 * - Bare text (no `/`) -> null (must use a slash command)
 * - Unknown `/command` -> null
 * - Empty string -> null
 */
export function parseHomeCommand(input: string): CommandResult | null {
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

  switch (command) {
    case "work":
      return { workflow: "work", args: rest ? { planPath: rest } : {} }

    case "plan":
      return { workflow: "plan", args: rest ? { description: rest } : {} }

    case "review":
      return { workflow: "review", args: {} }

    case "ship":
      return { workflow: "ship", args: {} }

    case "debug":
      return { workflow: "debug", args: rest ? { description: rest } : {} }

    case "research":
      return { workflow: "research", args: rest ? { topic: rest } : {} }

    case "config":
      return { workflow: "config", args: {} }

    case "exit":
      return { workflow: "exit", args: {} }

    case "help":
      return { workflow: "help", args: {} }

    default:
      return null
  }
}

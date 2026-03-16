/**
 * Flywheel Command Definitions
 *
 * Single source of truth for all slash commands.
 */

export interface SlashCommand {
  name: string
  description: string
  category?: string
}

export const COMMANDS: SlashCommand[] = [
  { name: "/work",     description: "Run a plan (paste path or pick from recent)" },
  { name: "/plan",     description: "Create a new plan from description" },
  { name: "/review",   description: "Review current changes" },
  { name: "/ship",     description: "Commit, PR, and compound learnings" },
  { name: "/debug",    description: "Debug a failing test or issue" },
  { name: "/research", description: "Research a topic in the codebase" },
  { name: "/config",   description: "Edit flywheel.yaml" },
  { name: "/help",     description: "Show available commands" },
  { name: "/new",      description: "Start fresh from idle screen" },
  { name: "/exit",     description: "Exit flywheel" },
]

/** Commands shown as help rows on the home screen */
export const HOME_HELP_COMMANDS = COMMANDS.filter((c) =>
  ["/work", "/plan", "/review", "/ship"].includes(c.name)
)

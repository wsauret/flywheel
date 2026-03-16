/**
 * Flywheel Command Definitions
 *
 * Slash commands available from the home screen.
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
  { name: "/exit",     description: "Exit flywheel" },
]

/** Commands shown as help rows on the home screen */
export const HOME_HELP_COMMANDS = COMMANDS.filter((c) =>
  ["/work", "/plan", "/review", "/ship"].includes(c.name)
)

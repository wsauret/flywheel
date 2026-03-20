/**
 * Flywheel Command Definitions
 *
 * Single source of truth for all slash commands.
 * The `argKey` field tells `parseCommand` how to map the "rest"
 * of user input into a named argument (e.g., `/work foo.md` →
 * `{ planPath: "foo.md" }`). Commands without `argKey` take no args.
 */

export interface SlashCommand {
  name: string
  description: string
  category?: string
  /** Key under which trailing text is stored in `args`. Omit if no args. */
  argKey?: string
}

export const COMMANDS: SlashCommand[] = [
  { name: "/work",     description: "Run a plan (paste path or pick from recent)", argKey: "planPath" },
  { name: "/plan",     description: "Create a new plan from description",          argKey: "description" },
  { name: "/review",   description: "Review current changes" },
  { name: "/ship",     description: "Commit, PR, and compound learnings" },
  { name: "/debug",    description: "Debug a failing test or issue",               argKey: "description" },
  { name: "/research", description: "Research a topic in the codebase",            argKey: "topic" },
  { name: "/start",    description: "Guided workflow launcher",              argKey: "description" },
  { name: "/config",   description: "Edit flywheel.yaml" },
  { name: "/help",     description: "Show available commands" },
  { name: "/new",      description: "Start fresh from idle screen" },
  { name: "/exit",     description: "Exit flywheel" },
]

/**
 * Lookup table: command name (without `/`) → SlashCommand.
 * Derived from COMMANDS so parseCommand stays in sync automatically.
 */
export const COMMAND_MAP: ReadonlyMap<string, SlashCommand> = new Map(
  COMMANDS.map((c) => [c.name.slice(1), c]),
)

/** Commands shown as help rows on the home screen */
export const HOME_HELP_COMMANDS = COMMANDS.filter((c) =>
  ["/start", "/work", "/plan", "/review", "/ship"].includes(c.name)
)

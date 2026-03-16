/**
 * Type-safe CLI argument parsing.
 *
 * Modes:
 * - `flywheel` (no args) -> persistent TUI shell
 * - `flywheel work <plan-path>` -> headless work execution (no TUI)
 * - `flywheel plan <description>` -> headless plan workflow
 * - `flywheel review` -> headless review workflow
 * - `flywheel ship` -> headless ship workflow
 * - `flywheel debug <description>` -> headless debug workflow
 * - `flywheel research <topic>` -> headless research workflow
 */

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ParsedArgs =
  | { command: "tui" }
  | { command: "work"; planPath: string; config?: string }
  | { command: "plan"; description: string }
  | { command: "review" }
  | { command: "ship" }
  | { command: "debug"; description: string }
  | { command: "research"; topic: string };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse CLI arguments using yargs.
 *
 * - No args -> `{ command: "tui" }`
 * - `work <plan-path>` -> `{ command: "work", planPath, config? }`
 * - `plan <description>` -> `{ command: "plan", description }`
 * - `review` -> `{ command: "review" }`
 * - `ship` -> `{ command: "ship" }`
 * - `debug <description>` -> `{ command: "debug", description }`
 * - `research <topic>` -> `{ command: "research", topic }`
 *
 * @param argv - Raw argv array (default: process.argv via hideBin)
 * @returns Parsed command and arguments, or null on parse error
 */
export async function parseArgs(
  argv?: string[],
): Promise<ParsedArgs | null> {
  const raw = argv ?? hideBin(process.argv);

  let parseError: string | null = null;

  const parsed = await yargs(raw)
    .scriptName("flywheel")
    .command("$0", "Launch the flywheel TUI")
    .command("work <plan-path>", "Run a plan in headless mode", (y) => {
      return y.positional("plan-path", {
        describe: "Path to plan markdown file",
        type: "string",
        demandOption: true,
      });
    })
    .command("plan <description>", "Create a plan from a feature description", (y) => {
      return y.positional("description", {
        describe: "Feature description to plan",
        type: "string",
        demandOption: true,
      });
    })
    .command("review", "Review current code changes")
    .command("ship", "Commit, create PR, and compound learnings")
    .command("debug <description>", "Debug a failing test or issue", (y) => {
      return y.positional("description", {
        describe: "Problem description",
        type: "string",
        demandOption: true,
      });
    })
    .command("research <topic>", "Research a topic in the codebase", (y) => {
      return y.positional("topic", {
        describe: "Topic to research",
        type: "string",
        demandOption: true,
      });
    })
    .option("config", {
      alias: "c",
      type: "string",
      describe: "Path to TOML configuration file",
    })
    .help()
    .strict()
    .exitProcess(false)
    .fail((msg, _err) => {
      parseError = msg;
    })
    .parseAsync();

  if (parseError) {
    return null;
  }

  // Check for subcommand workflows
  const cmd = parsed._ && parsed._[0];

  if (cmd === "work") {
    const planPath = parsed["plan-path"] as string;
    if (!planPath) {
      console.error("Error: work requires a plan path. Usage: flywheel work <plan-path>");
      return null;
    }
    return { command: "work", planPath, config: parsed.config as string | undefined };
  }

  if (cmd === "plan") {
    const description = parsed.description as string;
    if (!description) {
      console.error("Error: plan requires a description. Usage: flywheel plan <description>");
      return null;
    }
    return { command: "plan", description };
  }

  if (cmd === "review") {
    return { command: "review" };
  }

  if (cmd === "ship") {
    return { command: "ship" };
  }

  if (cmd === "debug") {
    const description = parsed.description as string;
    if (!description) {
      console.error("Error: debug requires a description. Usage: flywheel debug <description>");
      return null;
    }
    return { command: "debug", description };
  }

  if (cmd === "research") {
    const topic = parsed.topic as string;
    if (!topic) {
      console.error("Error: research requires a topic. Usage: flywheel research <topic>");
      return null;
    }
    return { command: "research", topic };
  }

  // No args -> TUI mode
  return { command: "tui" };
}

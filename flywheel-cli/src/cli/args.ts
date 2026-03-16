/**
 * Type-safe CLI argument parsing.
 *
 * Two modes:
 * - `flywheel` (no args) → persistent TUI shell
 * - `flywheel --headless <plan-path>` → headless execution (no TUI)
 */

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeadlessArgs {
  planPath: string;
  config?: string;
}

export type ParsedArgs =
  | { command: "tui" }
  | { command: "work-headless"; args: HeadlessArgs };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse CLI arguments using yargs.
 *
 * - No args → `{ command: "tui" }`
 * - `--headless <plan-path>` → `{ command: "work-headless", args: { planPath, config? } }`
 * - `--headless` without plan path → error (returns null)
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
    .command("$0 [plan-path]", "Run flywheel", (y) => {
      return y.positional("plan-path", {
        describe: "Path to plan markdown file (required with --headless)",
        type: "string",
      });
    })
    .option("headless", {
      type: "boolean",
      default: false,
      describe: "Run without TUI — requires a plan path as positional arg",
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

  const planPath = parsed["plan-path"] as string | undefined;

  // --headless mode: requires a plan path
  if (parsed.headless) {
    if (!planPath) {
      console.error("Error: --headless requires a plan path. Usage: flywheel --headless <plan-path>");
      return null;
    }

    return {
      command: "work-headless",
      args: {
        planPath,
        config: parsed.config as string | undefined,
      },
    };
  }

  // Bare positional without --headless → error
  if (planPath) {
    console.error(
      `Error: unexpected argument "${planPath}". ` +
      "Use 'flywheel' for the TUI or 'flywheel --headless <plan-path>' for headless mode."
    );
    return null;
  }

  // No args → TUI mode
  return { command: "tui" };
}

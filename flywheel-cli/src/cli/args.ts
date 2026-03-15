/**
 * Type-safe yargs argument parsing.
 *
 * Defines `flywheel work <plan-path>` command with typed options.
 */

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkArgs {
  planPath: string;
  config?: string;
  headless: boolean;
}

export interface ParsedArgs {
  command: "work";
  args: WorkArgs;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse CLI arguments using yargs.
 *
 * @param argv - Raw argv array (default: process.argv)
 * @returns Parsed command and arguments
 */
export async function parseArgs(
  argv?: string[],
): Promise<ParsedArgs | null> {
  const raw = argv ?? hideBin(process.argv);

  let parseError: string | null = null;

  const parsed = await yargs(raw)
    .scriptName("flywheel")
    .usage("$0 <command> [options]")
    .command(
      "work <plan-path>",
      "Run the execution loop against a plan",
      (yargs) => {
        return yargs.positional("plan-path", {
          describe: "Path to the plan markdown file",
          type: "string",
          demandOption: true,
        });
      },
    )
    .option("config", {
      alias: "c",
      type: "string",
      describe: "Path to TOML configuration file",
    })
    .option("headless", {
      type: "boolean",
      default: false,
      describe: "Run without TUI (v1+)",
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

  const command = parsed._[0];

  if (command === "work") {
    return {
      command: "work",
      args: {
        planPath: parsed["plan-path"] as string,
        config: parsed.config as string | undefined,
        headless: parsed.headless as boolean,
      },
    };
  }

  // No recognized command
  return null;
}

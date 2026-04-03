#!/usr/bin/env bun
/**
 * CLI entry point.
 *
 * `flywheel` -> persistent TUI shell (all workflow creation happens inside)
 *
 * IMPORTANT: solid-js must resolve with "browser" condition (not "node").
 * Run via `bin/flywheel` or `bun --conditions=browser run src/cli/index.ts`.
 */

import { Log } from "../utils/log"
import { installAgents } from "../agents/installer"
import { ensureRipgrepAddon } from "../harness/tools/ripgrep-build.js"


// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  // Initialize file-based logger before anything else.
  // --print-logs flag sends output to stderr instead of file (for debugging).
  const dir = process.env.FLYWHEEL_PROJECT_CWD || process.cwd()
  await Log.init({
    dir,
    print: process.argv.includes("--print-logs"),
    level: process.env.FLYWHEEL_LOG_LEVEL as Log.Level | undefined,
  })

  // Ensure ripgrep native addon is up to date (blocks if rebuild needed).
  ensureRipgrepAddon();

  // Sync agent personas to engine discovery paths (~/.claude/agents/fly/,
  // ~/.config/opencode/agents/fly/) so worker subprocesses can resolve
  // fly/* agents natively via their Task tool.
  installAgents().catch((err) => {
    Log.Default.warn("agent installation failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    })
  })

  await runTUI();
}

// ---------------------------------------------------------------------------
// TUI mode — persistent shell
// ---------------------------------------------------------------------------

async function runTUI(): Promise<void> {
  const { startTUI } = await import("../tui/launcher");
  const tuiPromise = startTUI({ mode: "dark" });

  // Block until the shell exits (user types /exit or Ctrl+C)
  await tuiPromise;

  // Terminal is already restored by exitTUI() — safe to exit
  process.exit(process.exitCode ?? 0);
}

// Auto-run when executed directly
if (import.meta.main) {
  main().catch((err) => {
    Log.Default.error("fatal", { error: err instanceof Error ? err : String(err) })
    process.exit(1);
  });
}

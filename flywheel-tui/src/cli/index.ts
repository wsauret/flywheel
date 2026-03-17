#!/usr/bin/env bun
/**
 * CLI entry point.
 *
 * `flywheel` -> persistent TUI shell (all workflow creation happens inside)
 *
 * IMPORTANT: solid-js must resolve with "browser" condition (not "node").
 * Run via `bin/flywheel` or `bun --conditions=browser run src/cli/index.ts`.
 */

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
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
    console.error(err);
    process.exit(1);
  });
}

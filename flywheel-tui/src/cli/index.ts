#!/usr/bin/env bun
/**
 * CLI entry point.
 *
 * `flywheel` -> persistent TUI shell (all workflow creation happens inside)
 *
 * IMPORTANT: solid-js must resolve with "browser" condition (not "node").
 * Run via `bin/flywheel` or `bun --conditions=browser run src/cli/index.ts`.
 */

import { Log } from "../infra/log"
import { errorMessage } from "../infra/error-message"
import { installAgents } from "../workflows/agents/installer"


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

  // Sync agent personas to engine discovery paths (~/.claude/agents/fly/,
  // ~/.config/opencode/agents/fly/) so worker subprocesses can resolve
  // fly/* agents natively via their Task tool.
  installAgents().catch((err) => {
    Log.Default.warn("agent installation failed (non-fatal)", {
      error: errorMessage(err),
    })
  })

  // --headless branch MUST precede runTUI() to avoid singleton collision
  if (process.argv.includes("--headless")) {
    await runHeadless()
    return
  }

  await runTUI();
}

// ---------------------------------------------------------------------------
// Headless mode — run workflow without TUI
// ---------------------------------------------------------------------------

async function runHeadless(): Promise<void> {
  const descIdx = process.argv.indexOf("--description")
  const description = descIdx !== -1 ? process.argv[descIdx + 1] : undefined

  if (!description) {
    console.error(
      "Usage: flywheel --headless --description <text>\n\n" +
      "  --headless       Run without TUI (CI/automation)\n" +
      "  --description    Workflow description (required in headless mode)\n"
    )
    process.exit(1)
  }

  const { createHeadlessFactories } = await import("../orchestration/headless/factories")
  const { createSessionRegistry } = await import("../orchestration/session-registry")
  const { buildQueueFromTemplate } = await import("../workflows/queue/templates")
  const { randomUUID } = await import("crypto")

  // Create headless factories and pass to registry
  const factories = createHeadlessFactories({ logLevel: "normal", timestamps: true })
  const registry = createSessionRegistry(factories)
  const sessionId = randomUUID()
  const queue = buildQueueFromTemplate("work")

  // Wait for the session to reach a terminal state via callbacks
  const result = await new Promise<boolean>((resolve) => {
    registry.start({
      sessionId, queue, description,
      onRunnerDone: (_id, wfResult) => {
        resolve(wfResult.completed)
      },
      onRunnerError: (_id, err) => {
        console.error(`Error: ${errorMessage(err)}`)
        resolve(false)
      },
    })
  })

  await registry.disposeAll()
  process.exit(result ? 0 : 1)
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

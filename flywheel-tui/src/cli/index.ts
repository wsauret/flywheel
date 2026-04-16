#!/usr/bin/env bun

import { Log } from "../infra/log.js"
import { errorMessage } from "../infra/error-message.js"
import { installAgents } from "../workflows/agents/installer.js"
import "../orchestration/engines/register-all.js"
import "../workflows/queue/steps/register-all.js"


async function main(): Promise<void> {
  const dir = process.env.FLYWHEEL_PROJECT_CWD || process.cwd()
  await Log.init({
    dir,
    print: process.argv.includes("--print-logs"),
    level: process.env.FLYWHEEL_LOG_LEVEL as Log.Level | undefined,
  })

  installAgents().catch((err) => {
    Log.Default.warn("agent installation failed (non-fatal)", {
      error: errorMessage(err),
    })
  })

  // Must branch before startTUI() registers a global terminal raw-mode handler
  if (process.argv.includes("--headless")) {
    await runHeadless()
    return
  }

  await runTUI();
}

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

  const { runHeadless: run } = await import("../orchestration/headless/run-headless")
  const completed = await run(description)
  process.exit(completed ? 0 : 1)
}

async function runTUI(): Promise<void> {
  const { startTUI } = await import("../tui/launcher");
  const { exitTUI } = await import("../tui/exit.js");

  // Route terminal-close / kill signals through the same cleanup path as /exit,
  // so warm-pool subprocesses, worker subprocesses, and pending flushes are
  // disposed instead of orphaned. exitTUI() has a built-in 3s force-exit fallback.
  const signalHandler = () => exitTUI();
  process.on("SIGHUP", signalHandler);   // terminal/tab closed
  process.on("SIGTERM", signalHandler);  // kill / system shutdown
  process.on("SIGINT", signalHandler);   // Ctrl+C outside the TUI's key handler

  const tuiPromise = startTUI({ mode: "dark" });

  await tuiPromise;

  // exitTUI() restores terminal state; explicit exit prevents cleanup hooks from re-entering
  process.exit(process.exitCode ?? 0);
}

if (import.meta.main) {
  main().catch((err) => {
    Log.Default.error("fatal", { error: errorMessage(err) })
    process.exit(1);
  });
}

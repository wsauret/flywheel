#!/usr/bin/env bun
/**
 * CLI entry point (plain TS, thin entry point).
 *
 * `flywheel work <plan-path>` — runs controller loop.
 * `flywheel` (no args) — prints help.
 *
 * Graceful shutdown: calls `controller.shutdown()` (not direct subsystem calls).
 */

import { parseArgs } from "./args";
import { loadConfig, resolveModels } from "../config/loader";
import { getEngine } from "../engines/core/registry";
import { BunProcessSpawner } from "../worker/bun-spawner";
import { ConsoleAdapter } from "../tui/adapters/console";
import { WorkController } from "../controller/work";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv?: string[]): Promise<void> {
  const parsed = await parseArgs(argv);

  if (!parsed) {
    // No command or help was shown by yargs
    process.exitCode = 0;
    return;
  }

  if (parsed.command === "work") {
    await runWork(parsed.args.planPath, parsed.args.config);
  }
}

async function runWork(planPath: string, configPath?: string): Promise<void> {
  // Load config
  const { config, warnings } = loadConfig(configPath);
  for (const warning of warnings) {
    console.warn(warning);
  }

  // Resolve engine from config
  const engine = getEngine(config.engine);
  const models = resolveModels(config);
  console.log(`Engine: ${engine.metadata.name} (${engine.metadata.id})`);
  const workerModel = models.workerModel ?? engine.metadata.defaultModel;
  const dispatcherModel = models.dispatcherModel ?? engine.metadata.defaultModel;
  if (workerModel === dispatcherModel) {
    console.log(`Model: ${workerModel}${models.workerModel ? "" : " (default)"}`);
  } else {
    console.log(`Dispatcher model: ${dispatcherModel}`);
    console.log(`Worker model: ${workerModel}`);
  }

  // Create components (v1: MockAdapter, BunProcessSpawner)
  const spawner = new BunProcessSpawner({
    timeoutMinutes: config.timeout_minutes,
  });
  const ui = new ConsoleAdapter();

  const controller = new WorkController({
    config,
    spawner,
    engine,
    ui,
  });

  // Register shutdown handler
  const shutdown = async () => {
    await controller.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    const result = await controller.run(planPath);

    if (result.completed) {
      console.log(
        `All ${result.phasesTotal} phases completed successfully.`,
      );
    } else {
      console.error(
        `Stopped after ${result.phasesCompleted}/${result.phasesTotal} phases: ${result.reason}`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("Fatal error:", error);
    process.exitCode = 1;
  } finally {
    await controller.shutdown();
  }
}

// Auto-run when executed directly
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

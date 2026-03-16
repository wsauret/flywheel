#!/usr/bin/env bun
/**
 * CLI entry point.
 *
 * Modes:
 * - `flywheel` (no args) -> persistent TUI shell (all workflow creation happens inside)
 * - `flywheel work plan.md` -> headless work execution via ConsoleAdapter
 * - `flywheel plan "description"` -> plan workflow
 * - `flywheel review` -> review workflow
 * - `flywheel ship` -> ship workflow
 * - `flywheel debug "description"` -> debug workflow
 * - `flywheel research "topic"` -> research workflow
 *
 * IMPORTANT: solid-js must resolve with "browser" condition (not "node").
 * Run via `bin/flywheel` or `bun --conditions=browser run src/cli/index.ts`.
 */

import { parseArgs } from "./args";
import { loadConfig, resolveModels } from "../config/loader";
import { getEngine } from "../engines/core/registry";
import { BunProcessSpawner } from "../worker/bun-spawner";
import { ConsoleAdapter } from "../tui/adapters/console";
import { WorkController } from "../controller/work";
import type { IWorkflowUI } from "../tui/adapters/types";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv?: string[]): Promise<void> {
  const parsed = await parseArgs(argv);

  if (!parsed) {
    process.exitCode = 1;
    return;
  }

  switch (parsed.command) {
    case "tui":
      await runTUI();
      break;

    case "work":
      await runHeadless(parsed.planPath, parsed.config);
      break;

    case "plan":
      await runWorkflowHeadless("plan", { description: parsed.description });
      break;

    case "review":
      await runWorkflowHeadless("review", {});
      break;

    case "ship":
      await runWorkflowHeadless("ship", {});
      break;

    case "debug":
      await runWorkflowHeadless("debug", { description: parsed.description });
      break;

    case "research":
      await runWorkflowHeadless("research", { topic: parsed.topic });
      break;
  }
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

// ---------------------------------------------------------------------------
// Headless mode — ConsoleAdapter, no TUI
// ---------------------------------------------------------------------------

async function runHeadless(planPath: string, configPath?: string): Promise<void> {
  const { config, warnings } = loadConfig(configPath);
  for (const warning of warnings) console.warn(warning);

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

  const spawner = new BunProcessSpawner({ timeoutMinutes: config.timeout_minutes });
  const ui: IWorkflowUI = new ConsoleAdapter();
  const controller = new WorkController({ config, spawner, engine, ui });

  try {
    const result = await controller.run(planPath);
    if (result.completed) {
      console.log(`All ${result.phasesTotal} phases completed successfully.`);
    } else {
      console.error(`Stopped after ${result.phasesCompleted}/${result.phasesTotal} phases: ${result.reason}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("Fatal error:", error);
    process.exitCode = 1;
  } finally {
    await controller.shutdown();
  }
}

// ---------------------------------------------------------------------------
// Generic workflow headless mode
// ---------------------------------------------------------------------------

async function runWorkflowHeadless(
  workflowName: string,
  args: Record<string, string>,
): Promise<void> {
  const { workflowRegistry, WorkflowRunner, StepExecutor, buildWorkflowPrompt } =
    await import("../workflows/index");
  const { EventBus, createFlywheelEmitter } = await import("../events/event-bus");

  const workflow = workflowRegistry[workflowName];
  if (!workflow) {
    console.error(`Unknown workflow: ${workflowName}`);
    process.exitCode = 1;
    return;
  }

  const { config, warnings } = loadConfig();
  for (const warning of warnings) console.warn(warning);

  const engine = getEngine(config.engine);
  console.log(`Workflow: ${workflow.name} — ${workflow.description}`);
  console.log(`Engine: ${engine.metadata.name} (${engine.metadata.id})`);

  const spawner = new BunProcessSpawner({ timeoutMinutes: config.timeout_minutes });
  const ui: IWorkflowUI = new ConsoleAdapter();
  const eventBus = new EventBus();
  const emitter = createFlywheelEmitter(eventBus);

  ui.connect(eventBus);
  ui.start();

  const executor = new StepExecutor({
    spawner,
    emitter,
    engine,
    config,
    workflowId: `${workflowName}-headless`,
  });

  const runner = new WorkflowRunner({
    workflow,
    executor,
    emitter,
    ui,
    config,
    promptBuilder: (stepIndex, wf, prevResult) =>
      buildWorkflowPrompt(stepIndex, wf, args, prevResult, config.project_cwd),
  });

  try {
    const result = await runner.run();
    if (result.completed) {
      console.log(`All ${result.stepsTotal} steps completed successfully.`);
    } else {
      console.error(
        `Stopped after ${result.stepsCompleted}/${result.stepsTotal} steps: ${result.reason}`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("Fatal error:", error);
    process.exitCode = 1;
  } finally {
    ui.stop();
    ui.disconnect();
  }
}

// Auto-run when executed directly
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

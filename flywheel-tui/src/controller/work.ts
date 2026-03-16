/**
 * Work — composes execution loop + executor + event emitter.
 *
 * Provides a `run(planPath)` entry point and `shutdown()` method.
 * CLI `index.ts` calls only `shutdown()`, not individual subsystems (SRP).
 */

import * as path from "node:path";
import * as crypto from "node:crypto";
import { EventBus, createFlywheelEmitter } from "../events/event-bus";
import type { FlywheelConfig } from "../config/loader";
import type { ProcessSpawner } from "../worker/spawner";
import type { IWorkflowUI } from "../tui/adapters/types";
import type { Engine } from "../engines/core/types";
import { killAllActiveProcesses } from "../worker/process-lifecycle";
import { PhaseExecutor } from "./phase-executor";
import { WorkExecutionLoop, type ExecutionResult } from "./execution-loop";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkOptions {
  config: FlywheelConfig;
  spawner: ProcessSpawner;
  engine: Engine;
  ui: IWorkflowUI;
  /** Base directory for .flywheel/ files (default: cwd) */
  baseDir?: string;
}

// ---------------------------------------------------------------------------
// WorkController
// ---------------------------------------------------------------------------

export class WorkController {
  private readonly config: FlywheelConfig;
  private readonly spawner: ProcessSpawner;
  private readonly engine: Engine;
  private readonly ui: IWorkflowUI;
  private readonly baseDir: string;
  private readonly eventBus: EventBus;

  private loop: WorkExecutionLoop | null = null;

  constructor(options: WorkOptions) {
    this.config = options.config;
    this.spawner = options.spawner;
    this.engine = options.engine;
    this.ui = options.ui;
    this.baseDir = options.baseDir ?? process.cwd();
    this.eventBus = new EventBus();

    // Connect UI to event bus
    this.ui.connect(this.eventBus);
    this.ui.start();
  }

  /**
   * Get the event bus (for testing / external subscribers).
   */
  getEventBus(): EventBus {
    return this.eventBus;
  }

  /**
   * Run the work loop for a given plan.
   */
  async run(planPath: string): Promise<ExecutionResult> {
    const workflowId = crypto.randomUUID();
    const emitter = createFlywheelEmitter(this.eventBus);

    const absPlanPath = path.resolve(planPath);
    const planDir = path.dirname(absPlanPath);
    const planBasename = path.basename(absPlanPath, ".md");

    // Derive state and context paths
    const statePath = path.join(planDir, `${planBasename}.state.md`);
    const contextPath = path.join(planDir, `${planBasename}.context.md`);

    // Create executor
    const executor = new PhaseExecutor({
      spawner: this.spawner,
      emitter,
      config: this.config,
      engine: this.engine,
      workflowId,
    });

    // Create execution loop
    this.loop = new WorkExecutionLoop({
      planPath: absPlanPath,
      statePath,
      contextPath,
      executor,
      emitter,
      config: this.config,
      ui: this.ui,
      workflowId,
      baseDir: this.baseDir,
    });

    return this.loop.run();
  }

  /**
   * Graceful shutdown: stop UI, kill active processes, coordinate state writes.
   */
  async shutdown(): Promise<void> {
    // Request loop shutdown
    if (this.loop) {
      this.loop.requestShutdown();
    }

    // Kill all active worker processes
    await killAllActiveProcesses();

    // Stop and disconnect UI
    this.ui.stop();
    this.ui.disconnect();
  }
}

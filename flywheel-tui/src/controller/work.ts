/**
 * WorkController — backward-compatible shim wrapping createStageLoop.
 *
 * @deprecated Use `createStageLoop()` from `./stage-loop-factory` directly.
 * This shim exists only to keep existing test code working during the
 * migration period. New code should never import from this module.
 */

import { EventBus, createFlywheelEmitter } from "../events/event-bus";
import type { FlywheelConfig } from "../config/loader";
import type { ProcessSpawner } from "../worker/spawner";
import type { IWorkflowUI } from "../tui/adapters/types";
import type { Engine } from "../engines/core/types";
import type { BudgetTracker } from "../session/budget-tracker";
import type { BudgetLimits } from "../schemas/shared";
import type { ContextIndexer } from "../memory/indexer";
import type { DispatcherTransport } from "../dispatcher/transport";
import { createStageLoop, type StageLoopHandle } from "./stage-loop-factory";
import { ExecutionLoop, type ExecutionResult } from "./execution-loop";
import { killAllActiveProcesses } from "../worker/process-lifecycle";

// ---------------------------------------------------------------------------
// Types (preserved for backward compat)
// ---------------------------------------------------------------------------

export interface WorkOptions {
  config: FlywheelConfig;
  spawner: ProcessSpawner;
  engine: Engine;
  ui: IWorkflowUI;
  baseDir?: string;
  eventBus?: EventBus;
  budgetTracker?: BudgetTracker;
  budgetLimits?: BudgetLimits;
  contextIndexer?: ContextIndexer;
  dispatcherTransport?: DispatcherTransport;
}

// ---------------------------------------------------------------------------
// WorkController (deprecated shim)
// ---------------------------------------------------------------------------

/** @deprecated Use `createStageLoop()` from `./stage-loop-factory` instead. */
export class WorkController {
  private readonly config: FlywheelConfig;
  private readonly spawner: ProcessSpawner;
  private readonly engine: Engine;
  private readonly ui: IWorkflowUI;
  private readonly eventBus: EventBus;
  private readonly budgetTracker?: BudgetTracker;
  private readonly budgetLimits?: BudgetLimits;
  private readonly contextIndexer?: ContextIndexer;
  private readonly dispatcherTransport?: DispatcherTransport;

  private handle: StageLoopHandle | null = null;

  constructor(options: WorkOptions) {
    this.config = options.config;
    this.spawner = options.spawner;
    this.engine = options.engine;
    this.ui = options.ui;
    this.budgetTracker = options.budgetTracker;
    this.budgetLimits = options.budgetLimits;
    this.contextIndexer = options.contextIndexer;
    this.dispatcherTransport = options.dispatcherTransport;

    if (options.eventBus) {
      this.eventBus = options.eventBus;
    } else {
      this.eventBus = new EventBus();
      this.ui.connect(this.eventBus);
      this.ui.start();
    }
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }

  getLoop(): ExecutionLoop | null {
    return this.handle?.loop ?? null;
  }

  async run(
    planPath: string,
    onLoopReady?: (loop: ExecutionLoop) => void,
  ): Promise<ExecutionResult> {
    this.handle = createStageLoop({
      workflow: "work",
      args: { planPath },
      config: this.config,
      spawner: this.spawner,
      engine: this.engine,
      ui: this.ui,
      eventBus: this.eventBus,
      budgetTracker: this.budgetTracker,
      budgetLimits: this.budgetLimits,
      contextIndexer: this.contextIndexer,
      dispatcherTransport: this.dispatcherTransport,
    });

    onLoopReady?.(this.handle.loop);
    return this.handle.loop.run();
  }

  async shutdown(): Promise<void> {
    if (this.handle) {
      this.handle.shutdown();
    }
    await killAllActiveProcesses();
    this.ui.stop();
    this.ui.disconnect();
  }
}

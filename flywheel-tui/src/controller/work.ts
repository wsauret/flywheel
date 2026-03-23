/**
 * Work — composes unified ExecutionLoop with work-specific providers.
 *
 * Provides a `run(planPath)` entry point and `shutdown()` method.
 * Uses PlanFileProvider, FileStatePersistence, UIApprovalHandler,
 * and buildWorkPhasePrompt for the work execution path.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { EventBus, createFlywheelEmitter } from "../events/event-bus";
import type { FlywheelConfig } from "../config/loader";
import type { ProcessSpawner } from "../worker/spawner";
import type { IWorkflowUI } from "../tui/adapters/types";
import type { Engine } from "../engines/core/types";
import type { BudgetTracker } from "../session/budget-tracker";
import type { BudgetLimits } from "../schemas/shared";
import { killAllActiveProcesses } from "../worker/process-lifecycle";
import { PhaseExecutor } from "./phase-executor";
import { ExecutionLoop, type ExecutionResult, type PromptBuilder } from "./execution-loop";
import { PlanFileProvider } from "./plan-file-provider";
import { FileStatePersistence } from "./file-state-persistence";
import { UIApprovalHandler } from "./ui-approval-handler";
import { buildWorkPhasePrompt } from "../prompts/work/phase-prompt";
import { readCachedFile, parseContextFile } from "./templates";
import type { ContextIndexer } from "../memory/indexer";

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
  /** External event bus (e.g. from a pipeline session). When provided,
   *  the controller uses it instead of creating its own, and skips
   *  reconnecting the UI adapter (caller already connected it). */
  eventBus?: EventBus;
  /** Budget tracker for monitoring cost/invocation/token usage. */
  budgetTracker?: BudgetTracker;
  /** Budget limits to check against. Both tracker and limits must be provided together. */
  budgetLimits?: BudgetLimits;
  /** Context indexer for conventions/standards/learnings metadata. */
  contextIndexer?: ContextIndexer;
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
  private readonly budgetTracker?: BudgetTracker;
  private readonly budgetLimits?: BudgetLimits;
  private readonly contextIndexer?: ContextIndexer;

  private loop: ExecutionLoop | null = null;

  constructor(options: WorkOptions) {
    this.config = options.config;
    this.spawner = options.spawner;
    this.engine = options.engine;
    this.ui = options.ui;
    this.baseDir = options.baseDir ?? process.cwd();
    this.budgetTracker = options.budgetTracker;
    this.budgetLimits = options.budgetLimits;
    this.contextIndexer = options.contextIndexer;

    if (options.eventBus) {
      // Pipeline mode: reuse the session's unified event bus
      this.eventBus = options.eventBus;
    } else {
      // Standalone mode: create own bus and connect the UI
      this.eventBus = new EventBus();
      this.ui.connect(this.eventBus);
      this.ui.start();
    }
  }

  /**
   * Get the event bus (for testing / external subscribers).
   */
  getEventBus(): EventBus {
    return this.eventBus;
  }

  /**
   * Get the underlying ExecutionLoop (available after run() sets it up).
   * Returns null before run() is called or if setup hasn't reached loop creation.
   */
  getLoop(): ExecutionLoop | null {
    return this.loop;
  }

  /**
   * Run the work loop for a given plan.
   *
   * @param planPath - Path to the plan file
   * @param onLoopReady - Optional callback fired after the ExecutionLoop is created
   *   but before it starts running. Use this to capture the loop reference for
   *   mid-execution stdin injection.
   */
  async run(
    planPath: string,
    onLoopReady?: (loop: ExecutionLoop) => void,
  ): Promise<ExecutionResult> {
    const workflowId = crypto.randomUUID();
    const emitter = createFlywheelEmitter(this.eventBus);

    const absPlanPath = path.resolve(planPath);
    const planDir = path.dirname(absPlanPath);
    const planBasename = path.basename(absPlanPath, ".md");

    // Derive state and context paths
    const statePath = path.join(planDir, `${planBasename}.state.md`);
    const contextPath = path.join(planDir, `${planBasename}.context.md`);

    // Read plan content
    if (!fs.existsSync(absPlanPath)) {
      throw new Error(`Plan file not found: ${absPlanPath}`);
    }
    const planContent = fs.readFileSync(absPlanPath, "utf-8");

    // Create state persistence and load state
    const persistence = new FileStatePersistence(absPlanPath, statePath, this.baseDir);
    const state = persistence.load(planContent);

    // Create phase provider with state for cross-referencing
    const phaseProvider = new PlanFileProvider(planContent, state);

    // Create approval handler
    const approvalHandler = new UIApprovalHandler(emitter, this.config, this.ui, workflowId);

    // Load file references from context file
    const fileReferences = this.loadFileReferences(contextPath);

    // Create executor
    const executor = new PhaseExecutor({
      spawner: this.spawner,
      emitter,
      config: this.config,
      engine: this.engine,
      workflowId,
    });

    // Work prompt builder uses the rich buildWorkPhasePrompt template
    const promptBuilder: PromptBuilder = (phase, ctx) =>
      buildWorkPhasePrompt({
        ...ctx,
        planContent: phase.description,
      });

    // Create unified execution loop with work-specific providers
    this.loop = new ExecutionLoop({
      phaseProvider,
      promptBuilder,
      executor,
      emitter,
      config: this.config,
      ui: this.ui,
      workflowId,
      workflowLabel: absPlanPath,
      statePersistence: persistence,
      approvalHandler,
      fileReferences,
      keyDecisions: state.keyDecisions,
      planContent,
      statePath,
      contextPath,
      budgetTracker: this.budgetTracker,
      budgetLimits: this.budgetLimits,
      contextIndexer: this.contextIndexer,
    });
    this.loop.setLoadedState(state);

    // Notify caller that the loop is ready (for mid-execution stdin injection wiring).
    // This fires synchronously before the async loop.run() begins.
    onLoopReady?.(this.loop);

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

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private loadFileReferences(contextPath: string): string[] {
    const content = readCachedFile(contextPath);
    if (!content) return [];
    return parseContextFile(content);
  }
}

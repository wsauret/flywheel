/**
 * WorkflowRunner — generic sequential step runner for non-work workflows.
 *
 * Executes steps sequentially, emits events via FlywheelEmitter,
 * and supports graceful shutdown. All non-work workflows (plan, review,
 * ship, debug, research) use this runner.
 */

import * as crypto from "node:crypto";
import type { WorkflowDefinition } from "../schemas/workflow";
import type { FlywheelEmitter } from "../events/event-bus";
import type { FlywheelConfig } from "../config/loader";
import type { IWorkflowUI } from "../tui/adapters/types";
import type { StepExecutor } from "./step-executor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowRunnerOptions {
  workflow: WorkflowDefinition;
  executor: StepExecutor;
  emitter: FlywheelEmitter;
  ui: IWorkflowUI;
  config: FlywheelConfig;
  workflowId?: string;
  promptBuilder: (
    stepIndex: number,
    workflow: WorkflowDefinition,
    previousResult?: string,
  ) => string;
}

export interface WorkflowRunResult {
  completed: boolean;
  stepsCompleted: number;
  stepsTotal: number;
  reason?: string;
}

// ---------------------------------------------------------------------------
// WorkflowRunner
// ---------------------------------------------------------------------------

export class WorkflowRunner {
  private readonly workflow: WorkflowDefinition;
  private readonly executor: StepExecutor;
  private readonly emitter: FlywheelEmitter;
  private readonly config: FlywheelConfig;
  private readonly workflowId: string;
  private readonly promptBuilder: WorkflowRunnerOptions["promptBuilder"];

  private _shutdownRequested = false;
  private readonly _shutdownController = new AbortController();

  constructor(options: WorkflowRunnerOptions) {
    this.workflow = options.workflow;
    this.executor = options.executor;
    this.emitter = options.emitter;
    this.config = options.config;
    this.workflowId = options.workflowId ?? crypto.randomUUID();
    this.promptBuilder = options.promptBuilder;
  }

  /**
   * Request graceful shutdown. The runner stops after the current step.
   */
  requestShutdown(): void {
    this._shutdownRequested = true;
    this._shutdownController.abort();
  }

  /**
   * Run all steps sequentially.
   *
   * Emits workflow:started, phase:started/completed/failed for each step,
   * and workflow:completed or workflow:interrupted/failed at the end.
   *
   * Uses "phase" events because the TUI's WorkflowView and UIStore
   * are built around phase events — steps map 1:1 to phases in the event model.
   */
  async run(): Promise<WorkflowRunResult> {
    const steps = this.workflow.steps;
    const stepsTotal = steps.length;
    let stepsCompleted = 0;
    let previousResult: string | undefined;

    // Emit workflow started (planPath is the workflow name for non-work workflows)
    this.emitter.workflowStarted(this.workflowId, this.workflow.name);

    for (let i = 0; i < stepsTotal; i++) {
      if (this._shutdownRequested) {
        this.emitter.workflowInterrupted(
          this.workflowId,
          "Shutdown requested",
        );
        return {
          completed: false,
          stepsCompleted,
          stepsTotal,
          reason: "Shutdown requested",
        };
      }

      const step = steps[i];

      // Emit phase started (step maps to phase in the event model)
      this.emitter.phaseStarted(this.workflowId, i, step.description);

      // Build the prompt for this step
      const prompt = this.promptBuilder(i, this.workflow, previousResult);

      try {
        const result = await this.executor.executeStep({
          stepIndex: i,
          prompt,
          cwd: this.config.project_cwd,
          onStdout: (chunk) =>
            this.emitter.workerOutput(this.workflowId, "stdout", chunk),
          onStderr: (chunk) =>
            this.emitter.workerOutput(this.workflowId, "stderr", chunk),
          signal: this._shutdownController.signal,
        });

        // Capture output for next step's context
        previousResult = result.output;
        stepsCompleted++;
        this.emitter.phaseCompleted(this.workflowId, i);
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : String(error);

        this.emitter.phaseFailed(this.workflowId, i, reason);
        this.emitter.workflowFailed(this.workflowId, reason);

        return {
          completed: false,
          stepsCompleted,
          stepsTotal,
          reason,
        };
      }
    }

    // All steps complete
    this.emitter.workflowCompleted(this.workflowId);
    return { completed: true, stepsCompleted, stepsTotal };
  }
}

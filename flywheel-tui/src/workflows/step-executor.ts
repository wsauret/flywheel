/**
 * StepExecutor — spawns a worker for a single workflow step.
 *
 * Thin wrapper around PhaseExecutor that translates step semantics
 * into the existing phase execution infrastructure (retry, events, etc.).
 */

import type { ProcessSpawner } from "../worker/spawner";
import type { FlywheelEmitter } from "../events/event-bus";
import type { FlywheelConfig } from "../config/loader";
import type { Engine } from "../engines/core/types";
import type { WorkerResult } from "../schemas/worker";
import { PhaseExecutor } from "../controller/phase-executor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StepExecutorOptions {
  spawner: ProcessSpawner;
  emitter: FlywheelEmitter;
  engine: Engine;
  config: FlywheelConfig;
  workflowId: string;
}

export interface ExecuteStepOptions {
  stepIndex: number;
  prompt: string;
  cwd?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// StepExecutor
// ---------------------------------------------------------------------------

export class StepExecutor {
  private readonly phaseExecutor: PhaseExecutor;

  constructor(options: StepExecutorOptions) {
    this.phaseExecutor = new PhaseExecutor({
      spawner: options.spawner,
      emitter: options.emitter,
      config: options.config,
      engine: options.engine,
      workflowId: options.workflowId,
    });
  }

  /**
   * Execute a single step by delegating to PhaseExecutor.
   *
   * The step index maps to phaseIndex in the event system so the TUI
   * can track progress using the same infrastructure as work phases.
   */
  async executeStep(options: ExecuteStepOptions): Promise<WorkerResult> {
    return this.phaseExecutor.execute({
      phaseIndex: options.stepIndex,
      prompt: options.prompt,
      cwd: options.cwd,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
      signal: options.signal,
    });
  }
}

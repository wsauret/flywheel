/**
 * DispatcherOrchestrator — bridges the dispatcher transport with the execution loop.
 *
 * When `use_dispatcher` is true: assembles input, calls dispatcher, returns crafted prompt.
 * When `use_dispatcher` is false: returns static template prompt directly.
 * On any dispatcher failure: falls back to static template (never blocks execution).
 */

import type { FlywheelEmitter } from "../events/event-bus";
import type { FlywheelConfig } from "../config/loader";
import type { DispatcherTransport } from "../dispatcher/transport";
import type { PlanPhase } from "./plan-parser";
import { assembleDispatcherInput } from "../dispatcher/assemble";
import { buildPhasePrompt } from "./templates";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DispatcherOrchestratorOptions {
  transport: DispatcherTransport;
  emitter: FlywheelEmitter;
  config: FlywheelConfig;
  workflowId: string;
}

// ---------------------------------------------------------------------------
// DispatcherOrchestrator
// ---------------------------------------------------------------------------

export class DispatcherOrchestrator {
  private readonly transport: DispatcherTransport;
  private readonly emitter: FlywheelEmitter;
  private readonly config: FlywheelConfig;
  private readonly workflowId: string;

  constructor(options: DispatcherOrchestratorOptions) {
    this.transport = options.transport;
    this.emitter = options.emitter;
    this.config = options.config;
    this.workflowId = options.workflowId;
  }

  /**
   * Get the prompt for a phase, using dispatcher if enabled.
   * Falls back to static template on any error.
   */
  async getPhasePrompt(
    phase: PlanPhase,
    planContent: string,
    stateContent: string,
    contextContent?: string,
    lastWorkerResult?: string,
    keyDecisions?: string[],
    fileReferences?: string[],
    projectCwd?: string,
  ): Promise<string> {
    // If dispatcher is disabled, use static template directly
    if (!this.config.use_dispatcher) {
      return this.buildStaticPrompt(phase, keyDecisions, fileReferences, projectCwd);
    }

    // Emit dispatcher:invoked
    this.emitter.dispatcherInvoked(this.workflowId, phase.index, 0);

    try {
      // Assemble input
      const assembled = assembleDispatcherInput({
        planContent,
        stateContent,
        contextContent,
        lastWorkerResult,
      });

      // Call dispatcher
      const decision = await this.transport.invoke(assembled.input);

      // Emit dispatcher:completed
      this.emitter.dispatcherCompleted(this.workflowId, decision);

      return decision.prompt;
    } catch (error) {
      // Dispatcher failed — emit event and fall back to static template
      const reason = error instanceof Error ? error.message : String(error);
      this.emitter.dispatcherFailed(this.workflowId, reason);

      return this.buildStaticPrompt(phase, keyDecisions, fileReferences, projectCwd);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildStaticPrompt(
    phase: PlanPhase,
    keyDecisions?: string[],
    fileReferences?: string[],
    projectCwd?: string,
  ): string {
    return buildPhasePrompt({
      phase,
      keyDecisions: keyDecisions ?? [],
      fileReferences: fileReferences ?? [],
      projectCwd,
    });
  }
}

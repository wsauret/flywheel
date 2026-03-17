/**
 * DispatcherOrchestrator — bridges the dispatcher transport with the execution loop.
 *
 * When `use_dispatcher` is true: assembles input, calls dispatcher, returns crafted prompt.
 * On any dispatcher failure: returns null so the caller falls through to its own prompt builder.
 */

import type { FlywheelEmitter } from "../events/event-bus";
import type { FlywheelConfig } from "../config/loader";
import type { DispatcherTransport } from "../dispatcher/transport";
import type { PhaseInfo } from "./phase-provider";
import { assembleDispatcherInput } from "../dispatcher/assemble";

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
   * Get the prompt for a phase via the dispatcher transport.
   *
   * Returns `null` if the dispatcher is disabled or fails, allowing
   * the caller to fall through to its own prompt builder.
   */
  async getPhasePrompt(
    phase: PhaseInfo,
    planContent: string,
    stateContent: string,
    contextContent?: string,
    lastWorkerResult?: string,
  ): Promise<string | null> {
    // If dispatcher is disabled, let the caller handle prompt building
    if (!this.config.use_dispatcher) {
      return null;
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
      // Dispatcher failed — emit event and return null so caller uses its prompt builder
      const reason = error instanceof Error ? error.message : String(error);
      this.emitter.dispatcherFailed(this.workflowId, reason);

      return null;
    }
  }
}

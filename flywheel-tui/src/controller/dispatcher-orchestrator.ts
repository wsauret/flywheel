/**
 * DispatcherOrchestrator — bridges the dispatcher transport with the execution loop.
 *
 * Assembles input, calls dispatcher, returns crafted prompt.
 * On any dispatcher failure (after 2 retries): returns null so the caller falls through
 * to its own prompt builder.
 */

import type { FlywheelEmitter } from "../events/event-bus";
import type { FlywheelConfig } from "../config/loader";
import type { DispatcherTransport } from "../dispatcher/transport";
import type { DispatcherDecision } from "../schemas/dispatcher";
import type { LastWorkerResult } from "../schemas/shared";
import type { StageContext } from "./stage-context";
import type { PhaseInfo } from "./phase-provider";
import type { AssemblerInput } from "../dispatcher/assemble";
import { assembleDispatcherInput } from "../dispatcher/assemble";
import { Log } from "../utils/log";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DispatcherOrchestratorOptions {
  transport: DispatcherTransport;
  emitter: FlywheelEmitter;
  config: FlywheelConfig;
  workflowId: string;
}

/** Extended context for assembler — required fields per ADR spec. */
export interface PhasePromptOptions {
  workflowContext: AssemblerInput["workflowContext"];
  configContext: AssemblerInput["configContext"];
  sessionBudget: AssemblerInput["sessionBudget"];
  availableContext: AssemblerInput["availableContext"];
  /** Cumulative stage context from completed phases (optional). */
  stageContext?: StageContext;
}

const log = Log.create({ service: "dispatcher-orchestrator" });

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
   * Get the full dispatcher decision for a phase.
   *
   * Returns `null` if the dispatcher is disabled or fails, allowing
   * the caller to fall through to its own prompt builder.
   */
  async getPhaseDecision(
    phase: PhaseInfo,
    planContent: string,
    stateContent: string,
    contextContent: string | undefined,
    lastWorkerResult: LastWorkerResult | undefined,
    options: PhasePromptOptions,
  ): Promise<DispatcherDecision | null> {
    // Emit dispatcher:invoked
    this.emitter.dispatcherInvoked(this.workflowId, phase.index, 0);

    const MAX_RETRIES = 2;
    const BACKOFF_MS = 1_000;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Assemble input
        const assembled = assembleDispatcherInput({
          planContent,
          stateContent,
          contextContent,
          lastWorkerResult,
          workflowContext: options.workflowContext,
          configContext: options.configContext,
          sessionBudget: options.sessionBudget,
          availableContext: options.availableContext,
          stageContext: options.stageContext,
        });

        // Call dispatcher
        const decision = await this.transport.invoke(assembled.input);

        log.info("dispatcher decision received", {
          phaseIndex: phase.index,
          hasSessionName: !!decision.session_name,
          sessionName: decision.session_name ?? null,
          taskContentLength: decision.task_content.length,
          contextFiles: decision.context_files.length,
          warnings: decision.warnings?.length ?? 0,
        });

        // Emit dispatcher:completed
        this.emitter.dispatcherCompleted(this.workflowId, decision);

        return decision;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        if (attempt < MAX_RETRIES) {
          log.warn("dispatcher attempt failed, retrying", {
            attempt: attempt + 1,
            maxRetries: MAX_RETRIES,
            reason,
          });
          await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS * (attempt + 1)));
          continue;
        }

        // Final attempt failed — emit event and return null so caller uses its prompt builder
        this.emitter.dispatcherFailed(this.workflowId, reason);
        return null;
      }
    }

    // Should never reach here, but satisfy TypeScript
    return null;
  }

}

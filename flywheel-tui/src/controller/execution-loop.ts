/**
 * ExecutionLoop — unified execution loop using dependency injection.
 *
 * Uses PhaseProvider, StatePersistence, ApprovalHandler, and PromptBuilder
 * to handle both work (plan-file) and non-work (workflow-definition) paths.
 */

import * as fs from "node:fs";
import type { FlywheelEmitter } from "../events/event-bus";
import type { FlywheelConfig } from "../config/loader";
import type { IWorkflowUI } from "../tui/adapters/types";
import type { ParsedStateFile } from "../state/reader";
import type { PhaseInfo, PhaseProvider } from "./phase-provider";
import type { StatePersistence } from "./state-persistence";
import type { ApprovalHandler } from "./approval-handler";
import type { DispatcherOrchestrator } from "./dispatcher-orchestrator";
import type { WorkflowStepContext } from "../prompts/index";
import { readCachedFile } from "./templates";
import { wrapCompletionInstruction } from "../worker/completion";
import { PhaseExecutor, WorkerError } from "./phase-executor";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum size of previousResult passed between phases.
 * Caps at 200K chars (~50K tokens) to stay within model limits.
 */
const MAX_PHASE_RESULT_CHARS = 200_000;

const TRUNCATION_NOTICE =
  "\n\n[... output truncated for next phase — see full output above ...]\n";

// ---------------------------------------------------------------------------
// Unified types
// ---------------------------------------------------------------------------

/**
 * Prompt builder callback for the unified ExecutionLoop.
 *
 * Called for each phase to construct the prompt. The loop wraps the
 * result with `wrapCompletionInstruction` — builders should NOT
 * add the completion marker themselves.
 */
export type PromptBuilder = (phase: PhaseInfo, ctx: WorkflowStepContext) => string;

export interface UnifiedExecutionLoopOptions {
  phaseProvider: PhaseProvider;
  promptBuilder: PromptBuilder;
  executor: PhaseExecutor;
  emitter: FlywheelEmitter;
  config: FlywheelConfig;
  ui: IWorkflowUI;
  workflowId: string;
  /** Label for workflow:started event (plan path or workflow name) */
  workflowLabel: string;
  // Optional capabilities (work path provides these, non-work doesn't)
  statePersistence?: StatePersistence;
  approvalHandler?: ApprovalHandler;
  /** File references from .context.md (work path only) */
  fileReferences?: string[];
  /** Key decisions from state (work path only) */
  keyDecisions?: string[];
  /** Dispatcher orchestrator for dynamic prompt crafting (work path only) */
  dispatcherOrchestrator?: DispatcherOrchestrator;
  /** Optional plan content for dispatcher (work path only) */
  planContent?: string;
  /** Optional state path for dispatcher (work path only) */
  statePath?: string;
  /** Optional context path for dispatcher (work path only) */
  contextPath?: string;
}

export interface ExecutionResult {
  completed: boolean;
  phasesCompleted: number;
  phasesTotal: number;
  /** Reason for stopping if not all phases completed */
  reason?: string;
}

// ---------------------------------------------------------------------------
// ExecutionLoop (unified)
// ---------------------------------------------------------------------------

export class ExecutionLoop {
  private readonly phaseProvider: PhaseProvider;
  private readonly promptBuilder: PromptBuilder;
  private readonly executor: PhaseExecutor;
  private readonly emitter: FlywheelEmitter;
  private readonly config: FlywheelConfig;
  private readonly workflowId: string;
  private readonly workflowLabel: string;
  private readonly statePersistence?: StatePersistence;
  private readonly approvalHandler?: ApprovalHandler;
  private readonly fileReferences: string[];
  private readonly keyDecisions: string[];
  private readonly dispatcherOrchestrator?: DispatcherOrchestrator;
  private readonly planContent?: string;
  private readonly statePath?: string;
  private readonly contextPath?: string;

  private _shutdownRequested = false;
  private readonly _shutdownController = new AbortController();

  constructor(options: UnifiedExecutionLoopOptions) {
    this.phaseProvider = options.phaseProvider;
    this.promptBuilder = options.promptBuilder;
    this.executor = options.executor;
    this.emitter = options.emitter;
    this.config = options.config;
    this.workflowId = options.workflowId;
    this.workflowLabel = options.workflowLabel;
    this.statePersistence = options.statePersistence;
    this.approvalHandler = options.approvalHandler;
    this.fileReferences = options.fileReferences ?? [];
    this.keyDecisions = options.keyDecisions ?? [];
    this.dispatcherOrchestrator = options.dispatcherOrchestrator;
    this.planContent = options.planContent;
    this.statePath = options.statePath;
    this.contextPath = options.contextPath;
  }

  /**
   * Request graceful shutdown. The loop will stop after the current phase.
   */
  requestShutdown(): void {
    this._shutdownRequested = true;
    this._shutdownController.abort();
  }

  /**
   * Run the execution loop.
   *
   * 1. Get phases from provider
   * 2. For each phase: check shutdown, skip completed, handle approval, build prompt, execute, chain result
   * 3. Completion marker applied in the loop (not in prompt builders)
   * 4. previousResult always tracked and truncated
   * 5. On failure: emit phaseFailed + workflowFailed + optional workerFailed
   * 6. On success: emit phaseCompleted, update state if persistence exists
   */
  async run(): Promise<ExecutionResult> {
    const phases = this.phaseProvider.getPhases();

    if (phases.length === 0) {
      this.emitter.workflowFailed(this.workflowId, "No phases found");
      return { completed: false, phasesCompleted: 0, phasesTotal: 0, reason: "No phases found" };
    }

    // Emit workflow started
    this.emitter.workflowStarted(this.workflowId, this.workflowLabel);

    const phasesTotal = phases.length;
    let phasesCompleted = phases.filter((p) => p.status === "completed").length;
    let previousResult: string | undefined;

    // Iterate over phases
    for (const phase of phases) {
      if (this._shutdownRequested) {
        this.emitter.workflowInterrupted(
          this.workflowId,
          "Shutdown requested",
        );
        return {
          completed: false,
          phasesCompleted,
          phasesTotal,
          reason: "Shutdown requested",
        };
      }

      // Skip completed phases (but emit events so TUI shows them)
      if (phase.status === "completed") {
        this.emitter.phaseStarted(this.workflowId, phase.index, phase.title);
        this.emitter.phaseCompleted(this.workflowId, phase.index);
        continue;
      }

      // Handle [~] (in_progress / awaiting manual verification)
      if (phase.status === "in_progress" && this.approvalHandler) {
        const approved = await this.approvalHandler.requestApproval(phase.index, phase.title);
        if (!approved) {
          // Write rejection to state + error log
          this.statePersistence?.updatePhase(
            this.loadedState!,
            phase.index,
            "in_progress",
            `Phase ${phase.index + 1} approval rejected`,
          );
          this.emitter.phaseFailed(
            this.workflowId,
            phase.index,
            "Approval rejected",
          );
          return {
            completed: false,
            phasesCompleted,
            phasesTotal,
            reason: `Phase ${phase.index + 1} approval rejected`,
          };
        }
        // Approval granted — mark as completed
        this.statePersistence?.updatePhase(this.loadedState!, phase.index, "completed");
        phasesCompleted++;
        this.emitter.phaseCompleted(this.workflowId, phase.index);
        continue;
      }

      // Auto-approve in_progress phases when no approval handler (non-work)
      if (phase.status === "in_progress" && !this.approvalHandler) {
        this.emitter.phaseStarted(this.workflowId, phase.index, phase.title);
        this.emitter.phaseCompleted(this.workflowId, phase.index);
        phasesCompleted++;
        continue;
      }

      // Execute the phase
      this.emitter.phaseStarted(
        this.workflowId,
        phase.index,
        phase.title,
      );

      // Build prompt — try dispatcher first, fall through to prompt builder
      let prompt: string | null = null;
      if (this.dispatcherOrchestrator && this.planContent) {
        prompt = await this.dispatcherOrchestrator.getPhasePrompt(
          phase,
          this.planContent,
          this.statePath && fs.existsSync(this.statePath)
            ? fs.readFileSync(this.statePath, "utf-8")
            : "",
          this.contextPath ? readCachedFile(this.contextPath) ?? undefined : undefined,
          previousResult,
        );
      }
      if (prompt === null) {
        const ctx: WorkflowStepContext = {
          planContent: phase.description,
          keyDecisions: this.keyDecisions,
          fileReferences: this.fileReferences,
          previousResult,
          projectCwd: this.config.project_cwd,
        };
        prompt = this.promptBuilder(phase, ctx);
      }

      // Apply completion instruction in the loop (not in individual builders)
      prompt = wrapCompletionInstruction(prompt);

      try {
        const result = await this.executor.execute({
          phaseIndex: phase.index,
          prompt,
          cwd: this.config.project_cwd,
          onStdout: (chunk) => this.emitter.workerOutput(this.workflowId, "stdout", chunk),
          onStderr: (chunk) => this.emitter.workerOutput(this.workflowId, "stderr", chunk),
          signal: this._shutdownController.signal,
        });

        // Chain result for next phase (always on, truncated)
        previousResult = truncateForNextPhase(result.output);

        // Success: update state if persistence exists
        this.statePersistence?.updatePhase(this.loadedState!, phase.index, "completed");
        phasesCompleted++;
        this.emitter.phaseCompleted(this.workflowId, phase.index);
      } catch (error) {
        // Failure
        const reason =
          error instanceof WorkerError && error.result.failure
            ? error.result.failure.message
            : error instanceof Error
              ? error.message
              : String(error);

        // Update state if persistence exists
        this.statePersistence?.updatePhase(this.loadedState!, phase.index, "pending", reason);

        this.emitter.phaseFailed(this.workflowId, phase.index, reason);
        // Emit workflowFailed on all paths (not just non-work)
        this.emitter.workflowFailed(this.workflowId, reason);

        if (error instanceof WorkerError && error.result.failure) {
          this.emitter.workerFailed(
            this.workflowId,
            error.result.failure,
          );
        }

        return {
          completed: false,
          phasesCompleted,
          phasesTotal,
          reason,
        };
      }
    }

    // All phases complete
    this.emitter.workflowCompleted(this.workflowId);
    return { completed: true, phasesCompleted, phasesTotal };
  }

  // ---------------------------------------------------------------------------
  // Internal state tracking
  // ---------------------------------------------------------------------------

  /**
   * Loaded state reference for state persistence updates.
   * Set externally by the caller after loading state via persistence.load().
   */
  private _loadedState?: ParsedStateFile;

  /** Set the loaded state for persistence updates. */
  setLoadedState(state: ParsedStateFile): void {
    this._loadedState = state;
  }

  private get loadedState(): ParsedStateFile | undefined {
    return this._loadedState;
  }
}

// ---------------------------------------------------------------------------
// Helpers (unified)
// ---------------------------------------------------------------------------

/**
 * Truncate phase output so the next phase's prompt stays within model limits.
 * Keeps the tail (most recent content) which is typically the summary/conclusion.
 */
function truncateForNextPhase(output: string): string {
  if (output.length <= MAX_PHASE_RESULT_CHARS) return output;
  return TRUNCATION_NOTICE + output.slice(output.length - MAX_PHASE_RESULT_CHARS);
}



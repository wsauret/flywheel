/**
 * WorkExecutionLoop — pure state machine for phase execution.
 *
 * Reads plan phases, determines which to run, delegates execution
 * to PhaseExecutor, updates state file after each phase, and handles
 * [~] (manual verification) phases.
 *
 * Acquires full-cycle O_EXCL lock before state file writes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { FlywheelEmitter } from "../events/event-bus";
import type { FlywheelConfig } from "../config/loader";
import type { IWorkflowUI } from "../tui/adapters/types";
import type { ParsedStateFile } from "../state/reader";
import type { PlanPhase } from "./plan-parser";
import { parseStateFile } from "../state/reader";
import { writeStateFileAtomic } from "../state/writer";
import { acquireLock } from "../state/lock";
import { parsePlan } from "./plan-parser";
import { buildPhasePrompt, readCachedFile, parseContextFile } from "./templates";
import { PhaseExecutor, WorkerError } from "./phase-executor";
import type { DispatcherOrchestrator } from "./dispatcher-orchestrator";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecutionLoopOptions {
  planPath: string;
  statePath: string;
  contextPath?: string;
  executor: PhaseExecutor;
  emitter: FlywheelEmitter;
  config: FlywheelConfig;
  ui: IWorkflowUI;
  workflowId: string;
  baseDir: string;
  /** Optional dispatcher orchestrator for dynamic prompt crafting */
  dispatcherOrchestrator?: DispatcherOrchestrator;
}

export interface ExecutionResult {
  completed: boolean;
  phasesCompleted: number;
  phasesTotal: number;
  /** Reason for stopping if not all phases completed */
  reason?: string;
}

// ---------------------------------------------------------------------------
// WorkExecutionLoop
// ---------------------------------------------------------------------------

export class WorkExecutionLoop {
  private readonly planPath: string;
  private readonly statePath: string;
  private readonly contextPath?: string;
  private readonly executor: PhaseExecutor;
  private readonly emitter: FlywheelEmitter;
  private readonly config: FlywheelConfig;
  private readonly ui: IWorkflowUI;
  private readonly workflowId: string;
  private readonly baseDir: string;

  private _shutdownRequested = false;
  private readonly _shutdownController = new AbortController();
  private readonly dispatcherOrchestrator?: DispatcherOrchestrator;

  constructor(options: ExecutionLoopOptions) {
    this.planPath = options.planPath;
    this.statePath = options.statePath;
    this.contextPath = options.contextPath;
    this.executor = options.executor;
    this.emitter = options.emitter;
    this.config = options.config;
    this.ui = options.ui;
    this.workflowId = options.workflowId;
    this.baseDir = options.baseDir;
    this.dispatcherOrchestrator = options.dispatcherOrchestrator;
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
   * 1. Read plan -> parse phases
   * 3. Load/create state file
   * 4. Find first unchecked phase
   * 5. For each unchecked phase: execute, update state
   * 6. Handle [~] phases via approval callback
   */
  async run(): Promise<ExecutionResult> {
    // Read and parse plan
    const planContent = readPlanFile(this.planPath);
    const state = this.loadOrCreateState(planContent);
    const phases = parsePlan(planContent, state);

    if (phases.length === 0) {
      this.emitter.workflowFailed(this.workflowId, "No phases found in plan");
      return { completed: false, phasesCompleted: 0, phasesTotal: 0, reason: "No phases found in plan" };
    }

    // Emit workflow started
    this.emitter.workflowStarted(this.workflowId, this.planPath);

    const phasesTotal = phases.length;
    let phasesCompleted = phases.filter((p) => p.status === "completed").length;

    // Load context file references
    const fileReferences = this.loadFileReferences();

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
      if (phase.status === "in_progress") {
        const approved = await this.requestApproval(phase);
        if (!approved) {
          // Write rejection to state + error log
          this.updateStatePhase(state, phase.index, "in_progress", `Phase ${phase.index + 1} approval rejected`);
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
        this.updateStatePhase(state, phase.index, "completed");
        phasesCompleted++;
        this.emitter.phaseCompleted(this.workflowId, phase.index);
        continue;
      }

      // Execute the phase
      this.emitter.phaseStarted(
        this.workflowId,
        phase.index,
        phase.title,
      );

      let prompt: string;
      if (this.dispatcherOrchestrator && this.config.use_dispatcher) {
        prompt = await this.dispatcherOrchestrator.getPhasePrompt(
          phase,
          planContent,
          fs.existsSync(this.statePath) ? fs.readFileSync(this.statePath, "utf-8") : "",
          this.contextPath ? readCachedFile(this.contextPath) ?? undefined : undefined,
          undefined, // lastWorkerResult — not tracked yet
          state.keyDecisions,
          fileReferences,
          this.config.project_cwd,
        );
      } else {
        prompt = buildPhasePrompt({
          phase,
          keyDecisions: state.keyDecisions,
          fileReferences,
          projectCwd: this.config.project_cwd,
        });
      }

      try {
        await this.executor.execute({
          phaseIndex: phase.index,
          prompt,
          cwd: this.config.project_cwd,
          onStdout: (chunk) => this.emitter.workerOutput(this.workflowId, "stdout", chunk),
          onStderr: (chunk) => this.emitter.workerOutput(this.workflowId, "stderr", chunk),
          signal: this._shutdownController.signal,
        });

        // Success: update state to completed
        this.updateStatePhase(state, phase.index, "completed");
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

        this.updateStatePhase(state, phase.index, "pending", reason);

        this.emitter.phaseFailed(this.workflowId, phase.index, reason);

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
  // State management
  // ---------------------------------------------------------------------------

  private loadOrCreateState(planContent: string): ParsedStateFile {
    if (fs.existsSync(this.statePath)) {
      const content = fs.readFileSync(this.statePath, "utf-8");
      return parseStateFile(content);
    }

    // Create initial state from plan
    const titles = parsePlan(planContent).map((p) => p.title);
    const state: ParsedStateFile = {
      frontmatter: {
        plan: this.planPath,
        status: "in_progress",
        schema_version: 3,
      },
      title: path.basename(this.planPath, ".md"),
      phases: titles.map((name) => ({
        name,
        status: "pending" as const,
        annotations: {},
      })),
      keyDecisions: [],
      errorLog: [],
    };

    // Write initial state
    this.writeState(state);
    return state;
  }

  private updateStatePhase(
    state: ParsedStateFile,
    phaseIndex: number,
    status: "completed" | "pending" | "in_progress",
    errorMessage?: string,
  ): void {
    if (phaseIndex < state.phases.length) {
      state.phases[phaseIndex].status = status;
    }

    if (errorMessage) {
      state.errorLog.push({
        error: errorMessage,
        attempt: String(state.errorLog.length + 1),
        approach: "controller",
        outcome: status === "completed" ? "Resolved" : "Failed",
      });
    }

    this.writeState(state);
  }

  private writeState(state: ParsedStateFile): void {
    const planName = path.basename(this.planPath, ".md");
    const lock = acquireLock(planName, this.baseDir);
    try {
      writeStateFileAtomic(this.statePath, state);
    } finally {
      lock.release();
    }
  }

  // ---------------------------------------------------------------------------
  // Context / file references
  // ---------------------------------------------------------------------------

  private loadFileReferences(): string[] {
    if (!this.contextPath) return [];
    const content = readCachedFile(this.contextPath);
    if (!content) return [];
    return parseContextFile(content);
  }

  // ---------------------------------------------------------------------------
  // Approval handling
  // ---------------------------------------------------------------------------

  private async requestApproval(phase: PlanPhase): Promise<boolean> {
    if (this.config.skip_approval_gates) {
      return true;
    }

    // Use the UI adapter's approval callback
    return new Promise<boolean>((resolve) => {
      const existingCallback = this.ui.onApprovalDecision;

      if (!existingCallback) {
        // No approval callback — auto-approve
        this.emitter.approvalRequested(
          this.workflowId,
          phase.index,
          0,
          `Phase ${phase.index + 1}: ${phase.title}`,
        );
        this.emitter.approvalReceived(this.workflowId, true, true);
        resolve(true);
        return;
      }

      // Install resolver callback that will be called by the UI
      this.ui.onApprovalDecision = (approved: boolean) => {
        this.emitter.approvalReceived(this.workflowId, approved, false);
        // Restore original callback
        this.ui.onApprovalDecision = existingCallback;
        resolve(approved);
      };

      // Emit approval requested AFTER installing the callback
      this.emitter.approvalRequested(
        this.workflowId,
        phase.index,
        0,
        `Phase ${phase.index + 1}: ${phase.title}`,
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readPlanFile(planPath: string): string {
  if (!fs.existsSync(planPath)) {
    throw new Error(`Plan file not found: ${planPath}`);
  }
  return fs.readFileSync(planPath, "utf-8");
}

/**
 * ExecutionLoop — unified execution loop using dependency injection.
 *
 * Uses PhaseProvider, StatePersistence, ApprovalHandler, and PromptBuilder
 * to handle both work (plan-file) and non-work (workflow-definition) paths.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { FlywheelEmitter } from "../events/event-bus";
import type { FlywheelConfig } from "../config/loader";
import { HANDOFFS_DIR, LIBRARY_DIR } from "../config/paths";
import type { IWorkflowUI } from "../tui/adapters/types";
import type { ParsedStateFile } from "../state/reader";
import type { PhaseInfo, PhaseProvider } from "./phase-provider";
import type { StatePersistence } from "./state-persistence";
import type { ApprovalHandler } from "./approval-handler";
import type { DispatcherOrchestrator } from "./dispatcher-orchestrator";
import type { DispatcherDecision } from "../schemas/dispatcher";
import type { WorkflowStepContext } from "../prompts/index";
import type { BudgetTracker } from "../session/budget-tracker";
import type { BudgetLimits, LastWorkerResult, SessionBudgetStatus } from "../schemas/shared";
import type { ContextIndexer, ContextQuery } from "../memory/indexer";
import type { WorkflowType } from "./workflow-pipeline";
import type { EvaluatorTransport } from "../evaluator/transport";
import { Evaluator } from "../evaluator/invoke";
import type { EvaluationResult } from "../evaluator/invoke";
import { readCachedFile } from "./templates";
import { enrichPromptWithContext } from "./context-enrichment";
import type { WorkerResult } from "../schemas/worker";
import { PhaseExecutor, WorkerError } from "./phase-executor";
import { readHandoff, HandoffMissingError, HandoffInvalidError } from "../handoff/reader";
import { WorkerHandoffSchema } from "../schemas/handoff";
import type { WorkerHandoff, EvaluatorIssue } from "../schemas/handoff";
import type { EvaluatorHandoffData } from "../schemas/evaluator";
import { buildLastWorkerResult, buildPreviousResultFromHandoff } from "../handoff/consumers";
import {
  createEmptyStageContext,
  accumulatePhaseIntoContext,
  persistStageContext,
  loadStageContext,
  type StageContext,
  type PhaseHandoffSummary,
} from "./stage-context";
import { MilestoneTracker, type MilestonePhase } from "./milestone-tracker";
import { Log } from "../utils/log";

// ---------------------------------------------------------------------------
// Revision prompt builder
// ---------------------------------------------------------------------------

export interface BuildRevisionPromptOptions {
  /** Whether a sessionId is available for --resume */
  hasSessionId: boolean;
  /** Original prompt (prepended when no sessionId, i.e. fresh conversation) */
  originalPrompt?: string;
}

/**
 * Build a revision prompt from an EvaluationResult.
 *
 * When using --resume (hasSessionId=true): produces ONLY the evaluator
 * feedback as markdown, since the worker already has full context.
 *
 * When fresh conversation (hasSessionId=false): prepends original prompt
 * context + evaluator feedback.
 *
 * Format: ## Revision Required, ### Evaluator Reasoning, ### Feedback,
 * ### Suggestions (bulleted)
 */
export function buildRevisionPrompt(
  evalResult: EvaluationResult,
  options: BuildRevisionPromptOptions,
): string {
  const sections: string[] = [];

  // For fresh conversations without --resume, prepend original prompt
  if (!options.hasSessionId && options.originalPrompt) {
    sections.push(options.originalPrompt);
    sections.push(""); // blank line separator
  }

  sections.push("## Revision Required");
  sections.push("");

  if (evalResult.reasoning) {
    sections.push("### Evaluator Reasoning");
    sections.push(evalResult.reasoning);
    sections.push("");
  }

  if (evalResult.feedback) {
    sections.push("### Feedback");
    sections.push(evalResult.feedback);
    sections.push("");
  }

  if (evalResult.suggestions && evalResult.suggestions.length > 0) {
    sections.push("### Suggestions");
    for (const suggestion of evalResult.suggestions) {
      sections.push(`- ${suggestion}`);
    }
    sections.push("");
  }

  if (evalResult.reason && evalResult.reason !== evalResult.reasoning) {
    sections.push("### Evaluation Reason");
    sections.push(evalResult.reason);
    sections.push("");
  }

  return sections.join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// Unified types
// ---------------------------------------------------------------------------

/**
 * Prompt builder callback for the unified ExecutionLoop.
 *
 * Called for each phase to construct the prompt. Builders receive
 * `ctx.extra.handoffPath` and should include handoff instructions
 * when available.
 */
export type PromptBuilder = (phase: PhaseInfo, ctx: WorkflowStepContext) => string;

/**
 * Callback invoked after each executed phase completes successfully.
 *
 * Receives the phase index, the full (un-truncated) WorkerResult, and the
 * current accumulated extra data from previous steps. Returns additional
 * key-value pairs to merge into the accumulator, which is passed to the
 * next phase's prompt builder via `ctx.extra`.
 */
export type OnStepCompleteHook = (
  stepIndex: number,
  result: WorkerResult,
  accumulatedExtra: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/**
 * Callback invoked before executing a phase to decide whether to skip it.
 *
 * Receives the phase info and the current accumulated extra data from
 * previous steps. Returns `true` to skip the phase entirely (the phase
 * is marked completed and execution continues to the next phase).
 */
export type ShouldSkipPhaseHook = (
  phase: PhaseInfo,
  accumulatedExtra: Readonly<Record<string, unknown>>,
) => boolean;

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
  /**
   * Hook called after each phase completes. Returned data is merged into
   * an accumulator that is passed as `ctx.extra` to subsequent phases.
   */
  onStepComplete?: OnStepCompleteHook;
  /**
   * Hook called before executing a phase. If it returns `true`, the phase
   * is skipped (marked completed, events emitted, execution continues).
   * Useful for conditionally skipping steps based on accumulated data
   * from previous steps (e.g. skip review fix when no actionable findings).
   */
  shouldSkipPhase?: ShouldSkipPhaseHook;
  /** Budget tracker for monitoring cost/invocation/token usage. */
  budgetTracker?: BudgetTracker;
  /** Budget limits to check against. Both tracker and limits must be provided together. */
  budgetLimits?: BudgetLimits;
  /** Context indexer for providing conventions/standards/learnings to the dispatcher. */
  contextIndexer?: ContextIndexer;
  /** Callback invoked when the dispatcher generates a session name (first phase only). */
  onSessionName?: (name: string) => void;
  /** Evaluator transport for post-phase quality checks. When provided, enables evaluation. */
  evaluatorTransport?: EvaluatorTransport;
  /** Base directory for subprocess JSONL logging. When set, worker stdout/stderr is logged. */
  logBaseDir?: string;
  /**
   * Whether to load cumulative stage context from disk on construction.
   * Set to `true` when resuming an interrupted pipeline stage.
   * Defaults to `false` (starts with empty context for new stages).
   */
  resumeStageContext?: boolean;
  /**
   * Milestone tracker for detecting milestone completion and auto-injecting
   * validation phases (scrutiny + behavioral). When provided, enables
   * milestone-aware execution with auto-injection of validation phases
   * at milestone boundaries.
   *
   * Adapted from multi-agent mission system patterns.
   */
  milestoneTracker?: MilestoneTracker;
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

const log = Log.create({ service: "execution-loop" });

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
  private readonly onStepComplete?: OnStepCompleteHook;
  private readonly shouldSkipPhase?: ShouldSkipPhaseHook;
  private readonly budgetTracker?: BudgetTracker;
  private readonly budgetLimits?: BudgetLimits;
  private readonly contextIndexer?: ContextIndexer;
  private readonly onSessionName?: (name: string) => void;
  private readonly evaluatorTransport?: EvaluatorTransport;
  private readonly logBaseDir?: string;
  private readonly milestoneTracker?: MilestoneTracker;
  private _sessionNameEmitted = false;

  private _shutdownRequested = false;
  private readonly _shutdownController = new AbortController();

  /**
   * Accumulator for extra data passed between phases via onStepComplete hook.
   * Hoisted to instance level so callers can read accumulated data after run().
   */
  private readonly _extraAccumulator: Record<string, unknown> = {};

  /**
   * Structured LastWorkerResult from the most recent worker handoff.
   * Passed to the dispatcher for the next phase.
   */
  private _lastWorkerResult?: LastWorkerResult;

  /**
   * Cumulative stage context that grows as phases complete.
   * Fed to the dispatcher so each phase has visibility into prior decisions,
   * warnings, artifacts, and issues. Persisted to disk after each phase.
   */
  private _stageContext: StageContext;

  /**
   * Non-blocking issues from the evaluator for the current phase.
   * Accumulated into stage context after the phase completes.
   */
  private _pendingNonBlockingIssues: string[] = [];

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
    this.onStepComplete = options.onStepComplete;
    this.shouldSkipPhase = options.shouldSkipPhase;
    this.budgetTracker = options.budgetTracker;
    this.budgetLimits = options.budgetLimits;
    this.contextIndexer = options.contextIndexer;
    this.onSessionName = options.onSessionName;
    this.evaluatorTransport = options.evaluatorTransport;
    this.logBaseDir = options.logBaseDir;
    this.milestoneTracker = options.milestoneTracker;

    // Load stage context from disk when resuming, otherwise start fresh
    if (options.resumeStageContext) {
      const projectCwd = this.config.project_cwd ?? process.cwd();
      this._stageContext = loadStageContext(projectCwd) ?? createEmptyStageContext();
    } else {
      this._stageContext = createEmptyStageContext();
    }
  }

  /**
   * Request graceful shutdown. The loop will stop after the current phase.
   */
  requestShutdown(): void {
    this._shutdownRequested = true;
    this._shutdownController.abort();
  }

  /**
   * Inject a message into the currently running worker's stdin.
   *
   * Routes to the PhaseExecutor's StdinHandle (which is already
   * wrapped with engine-specific formatting for Claude, or handled
   * internally by the SDK spawner for OpenCode).
   *
   * @returns true if the message was written, false if no worker is active or pipe is closed.
   */
  injectToWorker(message: string): boolean {
    const handle = this.executor.getStdinHandle();
    if (!handle || !handle.isOpen) return false;
    const written = handle.write(message);
    if (written) {
      this.emitter.workerInjected(this.workflowId, message);
    }
    return written;
  }

  /**
   * Return accumulated extra data from onStepComplete hooks.
   *
   * Useful for retrieving data produced during execution (e.g. planFilePath
   * from the plan workflow) after run() completes.
   */
  getAccumulatedExtra(): Readonly<Record<string, unknown>> {
    return { ...this._extraAccumulator };
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

    // Resolve handoffs directory and ensure it exists
    const handoffsDir = path.resolve(
      this.config.project_cwd ?? process.cwd(),
      HANDOFFS_DIR,
    );
    fs.mkdirSync(handoffsDir, { recursive: true });

    // Ensure shared knowledge library directory exists for inter-worker knowledge sharing
    const libraryDir = path.resolve(
      this.config.project_cwd ?? process.cwd(),
      LIBRARY_DIR,
    );
    fs.mkdirSync(libraryDir, { recursive: true });

    // Use a mutable phases array to support dynamic validation phase injection.
    // phasesTotal tracks the growing total (initial + injected).
    let phasesTotal = phases.length;
    let phasesCompleted = phases.filter((p) => p.status === "completed").length;
    let previousResult: string | undefined;

    // Index-based loop to support dynamic phase injection at milestone boundaries.
    // When milestone completion is detected, validation phases are spliced in
    // right after the current phase, and the loop naturally picks them up.
    let phaseIdx = 0;
    while (phaseIdx < phases.length) {
      const phase = phases[phaseIdx];
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

      // Budget check — stop before dispatching if limits exceeded
      const budgetCheck = this.checkBudget();
      if (budgetCheck.exhausted) {
        return {
          completed: false,
          phasesCompleted,
          phasesTotal,
          reason: budgetCheck.reason,
        };
      }

      // Skip completed phases (but emit events so TUI shows them)
      if (phase.status === "completed") {
        this.emitter.phaseStarted(this.workflowId, phase.index, phase.title);
        this.emitter.phaseCompleted(this.workflowId, phase.index);
        phaseIdx++;
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
        (phase as { status: string }).status = "completed";
        this.statePersistence?.updatePhase(this.loadedState!, phase.index, "completed");
        phasesCompleted++;
        this.emitter.phaseCompleted(this.workflowId, phase.index);
        // Check milestone injection after approval-completed phase
        if (this.milestoneTracker) {
          const injected = this.injectValidationPhasesIfNeeded(phases, phaseIdx);
          if (injected > 0) phasesTotal += injected;
        }
        phaseIdx++;
        continue;
      }

      // Auto-approve in_progress phases when no approval handler (non-work)
      if (phase.status === "in_progress" && !this.approvalHandler) {
        this.emitter.phaseStarted(this.workflowId, phase.index, phase.title);
        (phase as { status: string }).status = "completed";
        this.emitter.phaseCompleted(this.workflowId, phase.index);
        phasesCompleted++;
        // Check milestone injection after auto-approved phase
        if (this.milestoneTracker) {
          const injected = this.injectValidationPhasesIfNeeded(phases, phaseIdx);
          if (injected > 0) phasesTotal += injected;
        }
        phaseIdx++;
        continue;
      }

      // Conditional skip — e.g. review fix step when no actionable findings
      if (this.shouldSkipPhase?.(phase, this._extraAccumulator)) {
        log.info("phase skipped by shouldSkipPhase hook", {
          phaseIndex: phase.index,
          title: phase.title,
        });
        this.emitter.phaseStarted(this.workflowId, phase.index, phase.title);
        (phase as { status: string }).status = "completed";
        this.statePersistence?.updatePhase(this.loadedState!, phase.index, "completed");
        phasesCompleted++;
        this.emitter.phaseCompleted(this.workflowId, phase.index);
        // Check milestone injection after skipped phase
        if (this.milestoneTracker) {
          const injected = this.injectValidationPhasesIfNeeded(phases, phaseIdx);
          if (injected > 0) phasesTotal += injected;
        }
        phaseIdx++;
        continue;
      }

      // Execute the phase
      this.emitter.phaseStarted(
        this.workflowId,
        phase.index,
        phase.title,
      );

      // 1. Cache context once per phase (reuse for both dispatcher and template)
      const relevantContext = this.contextIndexer?.getRelevantContext({
        workflowType: this.workflowLabel as WorkflowType,
        phaseDescription: phase.title,
      });

      log.info("phase_context resolved", {
        phaseIndex: phase.index,
        conventions: relevantContext?.conventions.length ?? 0,
        standards: relevantContext?.standards.length ?? 0,
        learnings: relevantContext?.learnings.length ?? 0,
      });

      // 2. Get dispatcher decision (may return null)
      const decision = await this.getDispatcherDecision(phase, phasesTotal, previousResult, relevantContext);

      // 3. Emit session name from first dispatcher response (fire-once)
      if (decision?.session_name && !this._sessionNameEmitted && this.onSessionName) {
        this._sessionNameEmitted = true;
        log.info("dispatcher returned session_name", { sessionName: decision.session_name });
        try { this.onSessionName(decision.session_name); } catch { /* best-effort */ }
      }
      if (decision && !decision.session_name && !this._sessionNameEmitted) {
        log.debug("dispatcher decision had no session_name", { phaseIndex: phase.index });
      }

      // 4. Resolve task content — dispatcher wins if non-empty, otherwise phase.description
      const resolvedPlanContent = (decision?.task_content && decision.task_content.trim())
        ? decision.task_content
        : phase.description;

      // 5. Generate invocationId and handoffPath before building context
      const invocationId = crypto.randomUUID();
      const handoffPath = path.resolve(handoffsDir, `${invocationId}.json`);

      // 6. Build context — template sees resolved planContent + accumulated extra + context entries + handoff
      const ctx: WorkflowStepContext = {
        planContent: resolvedPlanContent,
        keyDecisions: this.keyDecisions,
        fileReferences: this.fileReferences,
        previousResult,
        projectCwd: this.config.project_cwd,
        extra: {
          ...this._extraAccumulator,
          conventions: relevantContext?.conventions ?? [],
          standards: relevantContext?.standards ?? [],
          learnings: relevantContext?.learnings ?? [],
          handoffPath,
          invocationId,
          ...(this.config.boundaries ? { boundaries: this.config.boundaries } : {}),
        },
      };

      // 7. Template ALWAYS runs
      let prompt = this.promptBuilder(phase, ctx);

      // 8. Level 2 context inlining (from dispatcher decision, applied to composed prompt)
      if (decision?.context_to_inline && decision.context_to_inline.length > 0) {
        prompt = await enrichPromptWithContext(
          prompt,
          decision.context_to_inline,
          this.config.project_cwd ?? process.cwd(),
        );
      }

      const executeOptions = this.buildExecuteOptions(phase, prompt, decision, invocationId);

      try {
        let result = await this.executor.execute(executeOptions);

        // Increment invocation count after successful execution
        this.budgetTracker?.incrementInvocations();

        // --- Read worker handoff ONCE (best-effort, used by ALL consumers) ---
        let cachedHandoff: WorkerHandoff | undefined;
        try {
          cachedHandoff = await readHandoff(result.handoffPath, WorkerHandoffSchema);
        } catch (err) {
          if (err instanceof HandoffMissingError) {
            log.warn("worker handoff missing, consumers will use raw output", {
              phaseIndex: phase.index,
              path: result.handoffPath,
            });
          } else if (err instanceof HandoffInvalidError) {
            log.warn("worker handoff invalid, consumers will use raw output", {
              phaseIndex: phase.index,
              path: result.handoffPath,
              error: err.message,
            });
          } else {
            log.warn("unexpected error reading worker handoff, consumers will use raw output", {
              phaseIndex: phase.index,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // --- Evaluator: post-phase quality check with revision loop ---
        // Guards: transport exists, dispatcher produced a decision with validation_criteria,
        // and skip_evaluation is not set.
        if (
          this.evaluatorTransport &&
          !this.config.skip_evaluation &&
          decision &&
          decision.validation_criteria
        ) {
          const evaluator = new Evaluator({
            transport: this.evaluatorTransport,
            emitter: this.emitter,
            workflowId: this.workflowId,
            skipEvaluation: this.config.skip_evaluation,
            maxCycles: this.config.max_eval_cycles ?? 3,
            phaseIndex: phase.index,
            stepIndex: 0,
          });

          // Build task context for evaluator from phase description or resolved plan content
          const taskContext = phase.description || phase.title || "";

          // Project evaluator handoff from cached worker handoff
          const evaluatorHandoff: EvaluatorHandoffData | undefined = cachedHandoff
            ? {
                summary: cachedHandoff.summary,
                verification: cachedHandoff.verification,
                artifacts: cachedHandoff.artifacts,
                files_to_review: cachedHandoff.files_to_review,
                warnings: cachedHandoff.warnings,
                decisions: cachedHandoff.decisions,
              }
            : undefined;

          let evalResult = await evaluator.evaluate({
            workerOutput: result.output,
            validationCriteria: decision.validation_criteria,
            contextFiles: decision.context_files ?? [],
            durationSeconds: result.durationMs / 1000,
            testsPassed: null,
            artifactsProduced: [],
            taskContext: taskContext || undefined,
            handoff: evaluatorHandoff,
            stageContext: this._stageContext.phase_count > 0 ? this._stageContext : undefined,
          });

          // --- Evaluator transport failure: graceful degradation ---
          // When the evaluator fails due to transport/infrastructure error
          // (not a genuine verdict), continue execution. Log warning but do not
          // enter revision loop or halt the pipeline.
          if (evalResult.transportError) {
            log.warn("evaluator transport failed, continuing with graceful degradation", {
              phaseIndex: phase.index,
              reason: evalResult.reason,
              cyclesUsed: evalResult.cyclesUsed,
            });
            // Skip evaluation entirely — treat as if evaluator was not configured
            // (no revision loop, no issue gating, just continue)
          }

          // --- Revision loop + Issue gating ---
          // Only run when evaluator returned a genuine verdict (not a transport error).
          if (!evalResult.transportError) {

          // --- Revision loop ---
          // When evaluator returns passed:false, re-execute the phase with
          // evaluator feedback, up to max_revisions times.
          const maxRevisions = this.config.max_revisions ?? 0;
          let revisionAttempt = 0;
          const accumulatedFeedback: string[] = [];

          while (!evalResult.passed && !evalResult.skipped && revisionAttempt < maxRevisions) {
            // Check shutdown before each revision attempt
            if (this._shutdownRequested) {
              this.emitter.workflowInterrupted(
                this.workflowId,
                "Shutdown requested during revision",
              );
              return {
                completed: false,
                phasesCompleted,
                phasesTotal,
                reason: "Shutdown requested during revision",
              };
            }

            revisionAttempt++;

            // Accumulate feedback from failed attempt
            if (evalResult.feedback || evalResult.reason) {
              accumulatedFeedback.push(
                `Attempt ${revisionAttempt}: ${evalResult.feedback ?? evalResult.reason ?? "evaluation failed"}`,
              );
            }

            // Emit revision-requested event
            this.emitter.evaluatorRevisionRequested(
              this.workflowId,
              phase.index,
              revisionAttempt,
              maxRevisions,
              evalResult.reason ?? "Evaluation failed",
            );

            log.info("starting revision attempt", {
              phaseIndex: phase.index,
              revisionAttempt,
              maxRevisions,
              hasSessionId: !!result.sessionId,
              reason: evalResult.reason,
            });

            // Build revision prompt from evaluator feedback
            const hasSessionId = !!result.sessionId;
            const revisionPrompt = buildRevisionPrompt(evalResult, {
              hasSessionId,
              originalPrompt: hasSessionId ? undefined : prompt,
            });

            if (!hasSessionId) {
              log.warn("sessionId unavailable for revision, re-spawning without --resume", {
                phaseIndex: phase.index,
                revisionAttempt,
              });
            }

            // Generate new invocationId and handoffPath for revision
            const revisionInvocationId = crypto.randomUUID();
            const revisionHandoffPath = path.resolve(handoffsDir, `${revisionInvocationId}.json`);

            // Re-invoke executor with revision prompt (and resume session if available)
            const revisionOptions = this.buildExecuteOptions(phase, revisionPrompt, decision, revisionInvocationId);
            if (result.sessionId) {
              revisionOptions.resumeSessionId = result.sessionId;
            }

            // Execute revision — WorkerError propagates up to the catch block
            result = await this.executor.execute(revisionOptions);

            // Increment invocation count for revision
            this.budgetTracker?.incrementInvocations();

            // Read revised worker handoff (best-effort) — update cachedHandoff
            try {
              cachedHandoff = await readHandoff(result.handoffPath, WorkerHandoffSchema);
            } catch {
              cachedHandoff = undefined;
              log.warn("revision worker handoff read failed, evaluator will use raw output", {
                phaseIndex: phase.index,
                revisionAttempt,
              });
            }

            const revisionHandoff: EvaluatorHandoffData | undefined = cachedHandoff
              ? {
                  summary: cachedHandoff.summary,
                  verification: cachedHandoff.verification,
                  artifacts: cachedHandoff.artifacts,
                  files_to_review: cachedHandoff.files_to_review,
                  warnings: cachedHandoff.warnings,
                  decisions: cachedHandoff.decisions,
                }
              : undefined;

            // Evaluate revised output
            evalResult = await evaluator.evaluate({
              workerOutput: result.output,
              validationCriteria: decision.validation_criteria,
              contextFiles: decision.context_files ?? [],
              durationSeconds: result.durationMs / 1000,
              testsPassed: null,
              artifactsProduced: [],
              taskContext: taskContext || undefined,
              handoff: revisionHandoff,
              stageContext: this._stageContext.phase_count > 0 ? this._stageContext : undefined,
            });
          }

          // After the loop: check if evaluation ultimately passed
          if (!evalResult.passed && !evalResult.skipped) {
            // Accumulate the final failed attempt feedback
            if (evalResult.feedback || evalResult.reason) {
              accumulatedFeedback.push(
                `Final attempt: ${evalResult.feedback ?? evalResult.reason ?? "evaluation failed"}`,
              );
            }

            const evalReason = maxRevisions > 0
              ? `Evaluation failed after ${revisionAttempt} revision(s): ${accumulatedFeedback.join(" | ")}`
              : evalResult.reason
                ? `Evaluation failed: ${evalResult.reason}`
                : "Evaluation failed: criteria not met";

            log.info("evaluator rejected phase output", {
              phaseIndex: phase.index,
              cyclesUsed: evalResult.cyclesUsed,
              reason: evalResult.reason,
              revisionAttempts: revisionAttempt,
            });

            // Update state if persistence exists
            this.statePersistence?.updatePhase(this.loadedState!, phase.index, "pending", evalReason);

            this.emitter.phaseFailed(this.workflowId, phase.index, evalReason);
            this.emitter.workflowFailed(this.workflowId, evalReason);

            return {
              completed: false,
              phasesCompleted,
              phasesTotal,
              reason: evalReason,
            };
          }

          log.info("evaluator accepted phase output", {
            phaseIndex: phase.index,
            passed: evalResult.passed,
            skipped: evalResult.skipped,
            cyclesUsed: evalResult.cyclesUsed,
            revisionAttempts: revisionAttempt,
          });

          // --- Issue gating (additive to pass/fail) ---
          // After evaluator accepted the output, check structured issues.
          // Blocking issues halt the pipeline and surface via approval gate.
          // Non-blocking issues accumulate in stage context.
          const evaluatorIssues: EvaluatorIssue[] = evalResult.issues ?? [];
          const blockingIssues = evaluatorIssues.filter((i) => i.severity === "blocking");
          const nonBlockingIssues = evaluatorIssues.filter((i) => i.severity === "non_blocking");

          // Accumulate non-blocking issues into stage context
          if (nonBlockingIssues.length > 0) {
            this._pendingNonBlockingIssues = nonBlockingIssues.map((i) => i.description);
            log.info("non-blocking evaluator issues accumulated", {
              phaseIndex: phase.index,
              count: nonBlockingIssues.length,
            });
          }

          // Gate on blocking issues
          if (blockingIssues.length > 0) {
            log.warn("blocking evaluator issues detected", {
              phaseIndex: phase.index,
              count: blockingIssues.length,
              descriptions: blockingIssues.map((i) => i.description),
            });

            // Surface through approval gate if handler supports it
            let approved = false;
            if (this.approvalHandler?.requestIssueApproval) {
              approved = await this.approvalHandler.requestIssueApproval(
                phase.index,
                phase.title,
                blockingIssues,
              );
            }

            if (!approved) {
              const issueDescriptions = blockingIssues
                .map((i) => `[${i.category}] ${i.description}`)
                .join("; ");
              const gateReason = `Pipeline halted: ${blockingIssues.length} blocking issue(s) — ${issueDescriptions}`;

              this.statePersistence?.updatePhase(this.loadedState!, phase.index, "pending", gateReason);
              this.emitter.phaseFailed(this.workflowId, phase.index, gateReason);
              this.emitter.workflowFailed(this.workflowId, gateReason);

              return {
                completed: false,
                phasesCompleted,
                phasesTotal,
                reason: gateReason,
              };
            }

            log.info("blocking issues approved by user, continuing", {
              phaseIndex: phase.index,
              count: blockingIssues.length,
            });
          }
        } // end if (!transportError)
        } // end evaluator guard

        // Chain result for next phase:
        // - When handoff is available: build structured previousResult from handoff fields
        // - When handoff is missing: use raw output directly (no truncation)
        if (cachedHandoff) {
          previousResult = buildPreviousResultFromHandoff(cachedHandoff);
        } else {
          previousResult = result.output;
        }

        // Build structured lastWorkerResult from handoff (for dispatcher on next phase)
        if (cachedHandoff) {
          this._lastWorkerResult = buildLastWorkerResult(
            cachedHandoff,
            phase.index,
            result.durationMs,
          );
        } else {
          this._lastWorkerResult = undefined;
        }

        // Accumulate phase data into cumulative stage context
        {
          const phaseHandoff: PhaseHandoffSummary = {
            phase_index: phase.index,
            phase_title: phase.title,
            decisions: cachedHandoff?.decisions ?? [],
            warnings: cachedHandoff?.warnings ?? [],
            artifacts: [
              ...(cachedHandoff?.artifacts?.files_created ?? []),
              ...(cachedHandoff?.artifacts?.files_modified ?? []),
            ],
            issues: this._pendingNonBlockingIssues,
            skill_feedback: cachedHandoff?.skillFeedback ? {
              followedProcedure: cachedHandoff.skillFeedback.followedProcedure,
              deviations: cachedHandoff.skillFeedback.deviations,
              suggestedChanges: cachedHandoff.skillFeedback.suggestedChanges,
            } : undefined,
          };
          this._pendingNonBlockingIssues = []; // Reset for next phase
          this._stageContext = accumulatePhaseIntoContext(this._stageContext, phaseHandoff);

          // Persist stage context to disk for resume support
          const projectCwd = this.config.project_cwd ?? process.cwd();
          try {
            persistStageContext(this._stageContext, projectCwd);
          } catch (err) {
            log.warn("failed to persist stage context", {
              phaseIndex: phase.index,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Call onStepComplete hook with full result; merge returned data into accumulator
        if (this.onStepComplete) {
          const hookData = await this.onStepComplete(phase.index, result, { ...this._extraAccumulator });
          Object.assign(this._extraAccumulator, hookData);
        }

        // Success: update in-memory status and persist
        (phase as { status: string }).status = "completed";
        this.statePersistence?.updatePhase(this.loadedState!, phase.index, "completed");
        phasesCompleted++;
        this.emitter.phaseCompleted(this.workflowId, phase.index);

        // --- Milestone completion check and validation phase injection ---
        // After each phase completes, check if any milestone's implementation
        // phases are now all complete. If so, inject validation phases at the
        // top of the remaining queue (right after the current position).
        //
        // Adapted from multi-agent mission system patterns.
        if (this.milestoneTracker) {
          const injectedPhases = this.injectValidationPhasesIfNeeded(phases, phaseIdx);
          if (injectedPhases > 0) {
            phasesTotal += injectedPhases;
          }
        }
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

        // Rate limit exhaustion: treat as interruption (resumable), not failure
        if (error instanceof WorkerError && error.result.failure?.kind === "rate_limited") {
          const rateLimitReason = "Rate limit exhausted — workflow paused for resumption";
          this.emitter.phaseFailed(this.workflowId, phase.index, reason);
          this.emitter.workflowInterrupted(this.workflowId, rateLimitReason);

          if (error.result.failure) {
            this.emitter.workerFailed(this.workflowId, error.result.failure);
          }

          return {
            completed: false,
            phasesCompleted,
            phasesTotal,
            reason: rateLimitReason,
          };
        }

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

      phaseIdx++;
    }

    // All phases complete
    this.emitter.workflowCompleted(this.workflowId);
    return { completed: true, phasesCompleted, phasesTotal };
  }

  // ---------------------------------------------------------------------------
  // Milestone validation injection
  // ---------------------------------------------------------------------------

  /**
   * Check for milestone completion and inject validation phases into the
   * phases array right after the current position.
   *
   * This preserves relative order of existing pending phases — injected
   * validation phases run before any remaining implementation phases.
   *
   * Adapted from multi-agent mission system patterns:
   * - Scrutiny is inserted first (runs first)
   * - Behavioral validation is inserted second (runs after scrutiny)
   *
   * @param phases - Mutable phases array (will be spliced if injection needed)
   * @param currentIdx - Index of the phase that just completed
   * @returns Number of phases injected (0 if none)
   */
  private injectValidationPhasesIfNeeded(
    phases: PhaseInfo[],
    currentIdx: number,
  ): number {
    if (!this.milestoneTracker) return 0;

    // Project PhaseInfo[] into MilestonePhase[] for the tracker
    const milestonePhases: MilestonePhase[] = phases.map((p) => ({
      index: p.index,
      title: p.title,
      // Map PhaseInfo status to MilestonePhase status (cancelled maps to cancelled)
      status: p.status === "completed" ? "completed" : p.status === "in_progress" ? "in_progress" : "pending",
      milestone: p.milestone,
      // Detect validation phases by title prefix (Scrutiny: or Validation:)
      isValidation: p.title.startsWith("Scrutiny: ") || p.title.startsWith("Validation: "),
    }));

    const injections = this.milestoneTracker.checkAndCreateValidationPhases(
      milestonePhases,
      phases.length, // Start numbering after existing phases
      {
        skipScrutiny: this.config.skip_scrutiny,
        skipValidation: this.config.skip_validation,
      },
    );

    if (injections.length === 0) return 0;

    // Collect all validation phases to inject
    const allNewPhases: PhaseInfo[] = [];
    for (const injection of injections) {
      allNewPhases.push(...injection.phases);
      log.info("milestone validation triggered", {
        milestone: injection.milestone,
        phasesInjected: injection.phases.length,
        phaseNames: injection.phases.map((p) => p.title),
      });
    }

    if (allNewPhases.length === 0) return 0;

    // Re-index: validation phases get sequential indices starting after current max
    const maxIndex = phases.reduce((max, p) => Math.max(max, p.index), -1);
    for (let i = 0; i < allNewPhases.length; i++) {
      allNewPhases[i].index = maxIndex + 1 + i;
    }

    // Splice validation phases right after the current position.
    // This prepends them to the remaining queue while preserving
    // the relative order of existing pending phases.
    phases.splice(currentIdx + 1, 0, ...allNewPhases);

    return allNewPhases.length;
  }

  // ---------------------------------------------------------------------------
  // Dispatcher helpers
  // ---------------------------------------------------------------------------

  /**
   * Get the full dispatcher decision for the current phase.
   * Returns null if no dispatcher is configured or if the dispatcher fails.
   */
  private async getDispatcherDecision(
    phase: PhaseInfo,
    phasesTotal: number,
    previousResult: string | undefined,
    relevantContext?: { conventions: any[]; standards: any[]; learnings: any[] },
  ): Promise<DispatcherDecision | null> {
    if (!this.dispatcherOrchestrator || !this.planContent) {
      return null;
    }

    const availableContext = relevantContext ?? { conventions: [], standards: [], learnings: [] };

    log.info("available_context populated for dispatcher", {
      phaseIndex: phase.index,
      conventions: availableContext.conventions.length,
      standards: availableContext.standards.length,
      learnings: availableContext.learnings.length,
      hasIndexer: !!this.contextIndexer,
    });

    return this.dispatcherOrchestrator.getPhaseDecision(
      phase,
      this.planContent,
      this.statePath && fs.existsSync(this.statePath)
        ? fs.readFileSync(this.statePath, "utf-8")
        : "",
      this.contextPath ? readCachedFile(this.contextPath) ?? undefined : undefined,
      this._lastWorkerResult,
      {
        workflowContext: {
          workflowId: this.workflowId,
          name: this.workflowLabel,
          stepNumber: phase.index + 1,
          totalSteps: phasesTotal,
          stepDescription: phase.title,
        },
        configContext: {
          maxEvalCycles: this.config.max_eval_cycles,
          worktreePath: "",
          projectCwd: this.config.project_cwd ?? process.cwd(),
          workerModel: this.config.worker?.model ?? this.config.model ?? this.config.engine,
          dispatcherModel: this.config.dispatcher?.model ?? this.config.model ?? this.config.engine,
        },
        sessionBudget: this.getSessionBudget(),
        availableContext,
        stageContext: this._stageContext.phase_count > 0 ? this._stageContext : undefined,
      },
    );
  }

  /**
   * Get the current stage context (for testing/inspection).
   */
  getStageContext(): Readonly<StageContext> {
    return this._stageContext;
  }

  /**
   * Build ExecutePhaseOptions, applying worker_config overrides from the
   * dispatcher decision when present.
   */
  private buildExecuteOptions(
    phase: PhaseInfo,
    prompt: string,
    decision: DispatcherDecision | null,
    invocationId?: string,
  ): import("./phase-executor").ExecutePhaseOptions {
    const workerConfig = decision?.worker_config;

    // Guard: parallel execution not yet supported
    if (workerConfig?.parallel) {
      log.warn("parallel execution requested but not yet supported; proceeding single-threaded", {
        phaseIndex: phase.index,
      });
    }

    // Build timeout override
    let timeoutOverrideMs: number | undefined;
    if (workerConfig?.timeout_minutes != null) {
      const overrideMs = workerConfig.timeout_minutes * 60_000;
      const globalCapMs = this.config.timeout_minutes * 60_000;
      if (overrideMs > globalCapMs) {
        log.warn("dispatcher timeout override exceeds global config cap; clamping", {
          overrideMinutes: workerConfig.timeout_minutes,
          globalCapMinutes: this.config.timeout_minutes,
        });
        timeoutOverrideMs = globalCapMs;
      } else {
        timeoutOverrideMs = overrideMs;
      }
    }

    return {
      phaseIndex: phase.index,
      prompt,
      cwd: this.config.project_cwd,
      onStdout: (chunk) => this.emitter.workerOutput(this.workflowId, "stdout", chunk, this.config.engine),
      onStderr: (chunk) => this.emitter.workerOutput(this.workflowId, "stderr", chunk, this.config.engine),
      signal: this._shutdownController.signal,
      // Worker config overrides from dispatcher decision
      timeoutOverrideMs,
      modelOverride: workerConfig?.model_override ?? undefined,
      maxRetriesOverride: workerConfig?.max_retries,
      toolScoping: workerConfig?.tool_scoping,
      iterationBudget: workerConfig?.iteration_budget,
      invocationId,
      logBaseDir: this.logBaseDir,
    };
  }

  // ---------------------------------------------------------------------------
  // Budget helpers
  // ---------------------------------------------------------------------------

  /**
   * Check whether the budget has been exhausted.
   * Returns `{ exhausted: false }` when no budget tracking is configured.
   */
  private checkBudget(): { exhausted: boolean; reason?: string } {
    if (this.budgetTracker && this.budgetLimits && this.budgetTracker.isExhausted(this.budgetLimits)) {
      return { exhausted: true, reason: "Budget exhausted" };
    }
    return { exhausted: false };
  }

  /**
   * Build the sessionBudget object for the dispatcher.
   * Returns real values from the budget tracker when available,
   * otherwise falls back to unlimited defaults.
   */
  private getSessionBudget(): SessionBudgetStatus {
    if (this.budgetTracker && this.budgetLimits) {
      return this.budgetTracker.getBudgetStatus(this.budgetLimits);
    }
    return {
      invocations_remaining: null,
      token_budget_remaining: null,
      wall_clock_deadline: null,
    };
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




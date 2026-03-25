/**
 * Stage Loop Factory — single factory for creating ExecutionLoops for ANY workflow type.
 *
 * Replaces the dual-path pattern (WorkController for "work", inline ExecutionLoop
 * for everything else) with one configuration-driven factory. The dispatcher is
 * always wired when a transport is provided.
 *
 * Workflow-specific concerns are resolved through configuration switches:
 * - "work": PlanFileProvider, FileStatePersistence, UIApprovalHandler, work prompt builder
 * - "plan/review/ship/debug/research": WorkflowDefinitionProvider, workflow prompt builder, onStepComplete hooks
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { createFlywheelEmitter, type EventBus } from "../events/event-bus";
import type { FlywheelEmitter } from "../events/event-bus";
import type { FlywheelConfig } from "../config/loader";
import type { ProcessSpawner } from "../worker/spawner";
import type { Engine } from "../engines/core/types";
import type { IWorkflowUI } from "../tui/adapters/types";
import type { BudgetTracker } from "../session/budget-tracker";
import type { BudgetLimits } from "../schemas/shared";
import type { ContextIndexer } from "../memory/indexer";
import type { DispatcherTransport } from "../dispatcher/transport";
import type { EvaluatorTransport } from "../evaluator/transport";
import type { QuestionService } from "./question-service";
import type { OnStepCompleteHook, PromptBuilder, ShouldSkipPhaseHook } from "./execution-loop";
import type { WorkflowType } from "./workflow-pipeline";
import { ExecutionLoop, type ExecutionResult } from "./execution-loop";
import { PhaseExecutor } from "./phase-executor";
import { PlanFileProvider } from "./plan-file-provider";
import { FileStatePersistence } from "./file-state-persistence";
import { UIApprovalHandler } from "./ui-approval-handler";
import { WorkflowDefinitionProvider } from "./workflow-def-provider";
import { DispatcherOrchestrator } from "./dispatcher-orchestrator";
import { buildWorkPhasePrompt } from "../prompts/work/phase-prompt";
import { buildScrutinyPrompt } from "../prompts/work/scrutiny";
import {
  buildBehavioralValidationPrompt,
  collectAssertionsForMilestone,
  type ContractAssertion,
  type BehavioralValidationContext,
} from "../prompts/work/behavioral-validation";
import { readValidationState } from "./validation-state";
import { workflowRegistry, buildWorkflowPrompt } from "../workflows/index";
import { createPlanOnStepComplete } from "../workflows/plan-output-extractor";
import { createReviewOnStepComplete, REVIEW_FIX_STEP_INDEX } from "../workflows/review-output-extractor";
import { createShipOnStepComplete } from "../workflows/ship-output-extractor";
import { MilestoneTracker } from "./milestone-tracker";
import { readCachedFile, parseContextFile } from "./templates";
import { Log } from "../utils/log";

const log = Log.create({ service: "stage-loop-factory" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StageLoopOptions {
  /** Which workflow type to execute. */
  workflow: WorkflowType;
  /** Runtime arguments — planPath, description, topic, etc. */
  args: Record<string, string>;
  /** Core dependencies. */
  config: FlywheelConfig;
  spawner: ProcessSpawner;
  engine: Engine;
  /** Session plumbing. */
  ui: IWorkflowUI;
  eventBus: EventBus;
  /** Optional capabilities. */
  budgetTracker?: BudgetTracker;
  budgetLimits?: BudgetLimits;
  contextIndexer?: ContextIndexer;
  /** Dispatcher transport — when provided, the dispatcher is wired for every phase. */
  dispatcherTransport?: DispatcherTransport;
  /** Evaluator transport — when provided, enables post-phase quality evaluation. */
  evaluatorTransport?: EvaluatorTransport;
  /** Question service for interactive plan/review consolidation. */
  questionService?: QuestionService;
  /** Interactive overrides per workflow (plan, review). */
  interactiveOverrides?: { plan?: boolean; review?: boolean };
  /** Callback when the dispatcher returns a session_name on the first phase. */
  onSessionName?: (name: string) => void;
  /** Base directory for subprocess JSONL logging. When set, worker stdout/stderr is logged. */
  logBaseDir?: string;
}

export interface StageLoopHandle {
  /** The execution loop — call run() to start. */
  loop: ExecutionLoop;
  /** Request graceful shutdown. */
  shutdown(): void;
  /** Accumulated extra data from onStepComplete hooks (available after run completes). */
  getAccumulatedExtra(): Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fully configured ExecutionLoop for any workflow type.
 *
 * This is the single entry point for stage execution. All workflow-specific
 * behavior (phase source, prompt builder, approval, state persistence,
 * onStepComplete hooks) is resolved here through configuration switches.
 */
export function createStageLoop(options: StageLoopOptions): StageLoopHandle {
  const {
    workflow,
    args,
    config,
    spawner,
    engine,
    ui,
    eventBus,
    budgetTracker,
    budgetLimits,
    contextIndexer,
    dispatcherTransport,
    evaluatorTransport,
    questionService,
    interactiveOverrides,
    onSessionName,
    logBaseDir,
  } = options;

  const workflowId = `${workflow}-${crypto.randomUUID().slice(0, 8)}`;
  const emitter = createFlywheelEmitter(eventBus);
  const projectCwd = config.project_cwd || process.cwd();

  // Executor is universal — same for all workflow types.
  const executor = new PhaseExecutor({
    spawner,
    emitter,
    config,
    engine,
    workflowId,
  });

  // Dispatcher orchestrator — wired when a transport is provided.
  let dispatcherOrchestrator: DispatcherOrchestrator | undefined;
  if (dispatcherTransport) {
    dispatcherOrchestrator = new DispatcherOrchestrator({
      transport: dispatcherTransport,
      emitter,
      config,
      workflowId,
    });
    log.info("dispatcher wired", { workflow, workflowId });
  }

  // Log evaluator transport availability.
  if (evaluatorTransport) {
    log.info("evaluator transport wired", { workflow, workflowId });
  }

  // Resolve workflow-specific configuration.
  if (workflow === "work") {
    return createWorkLoop({
      workflowId,
      emitter,
      executor,
      dispatcherOrchestrator,
      config,
      ui,
      args,
      budgetTracker,
      budgetLimits,
      contextIndexer,
      evaluatorTransport,
      onSessionName,
      projectCwd,
      logBaseDir,
    });
  }

  return createGenericLoop({
    workflow,
    workflowId,
    emitter,
    executor,
    dispatcherOrchestrator,
    config,
    ui,
    args,
    budgetTracker,
    budgetLimits,
    contextIndexer,
    evaluatorTransport,
    questionService,
    interactiveOverrides,
    onSessionName,
    projectCwd,
    logBaseDir,
  });
}

// ---------------------------------------------------------------------------
// Work loop configuration
// ---------------------------------------------------------------------------

interface WorkLoopParams {
  workflowId: string;
  emitter: FlywheelEmitter;
  executor: PhaseExecutor;
  dispatcherOrchestrator?: DispatcherOrchestrator;
  config: FlywheelConfig;
  ui: IWorkflowUI;
  args: Record<string, string>;
  budgetTracker?: BudgetTracker;
  budgetLimits?: BudgetLimits;
  contextIndexer?: ContextIndexer;
  evaluatorTransport?: EvaluatorTransport;
  onSessionName?: (name: string) => void;
  projectCwd: string;
  logBaseDir?: string;
}

function createWorkLoop(params: WorkLoopParams): StageLoopHandle {
  const { workflowId, emitter, executor, config, ui, args, projectCwd } = params;

  const planPath = args.planPath;
  if (!planPath) {
    throw new Error("Work workflow requires a planPath argument.");
  }

  const absPlanPath = path.resolve(planPath);
  const planDir = path.dirname(absPlanPath);
  const planBasename = path.basename(absPlanPath, ".md");
  const statePath = path.join(planDir, `${planBasename}.state.md`);
  const contextPath = path.join(planDir, `${planBasename}.context.md`);

  if (!fs.existsSync(absPlanPath)) {
    throw new Error(`Plan file not found: ${absPlanPath}`);
  }
  const planContent = fs.readFileSync(absPlanPath, "utf-8");

  const baseDir = projectCwd;
  const persistence = new FileStatePersistence(absPlanPath, statePath, baseDir);
  const state = persistence.load(planContent);
  const phaseProvider = new PlanFileProvider(planContent, state);
  const approvalHandler = new UIApprovalHandler(emitter, config, ui, workflowId);

  // Load file references from .context.md
  const contextContent = readCachedFile(contextPath);
  const fileReferences = contextContent ? parseContextFile(contextContent) : [];

  // Prompt builder: detect scrutiny validation phases by title prefix
  // and use the scrutiny-specific prompt template.
  const promptBuilder: PromptBuilder = (phase, ctx) => {
    // Scrutiny phases have title "Scrutiny: <milestoneName>"
    if (phase.title.startsWith("Scrutiny: ")) {
      const milestoneName = phase.title.slice("Scrutiny: ".length);
      // Collect completed phases belonging to this milestone
      const allPhases = phaseProvider.getPhases();
      const completedPhases = allPhases
        .filter(
          (p) =>
            p.milestone === milestoneName &&
            p.status === "completed" &&
            // Exclude validation phases themselves
            !p.title.startsWith("Scrutiny: ") &&
            !p.title.startsWith("Validation: "),
        )
        .map((p) => ({
          index: p.index,
          title: p.title,
          description: p.description,
        }));

      return buildScrutinyPrompt({
        milestoneName,
        completedPhases,
        commands: config.commands,
        projectCwd,
      });
    }

    // Behavioral validation phases have title "Validation: <milestoneName>"
    if (phase.title.startsWith("Validation: ")) {
      const milestoneName = phase.title.slice("Validation: ".length);
      const allPhases = phaseProvider.getPhases();

      // Collect assertion IDs from completed phases' fulfills in this milestone
      const assertionIds = collectAssertionsForMilestone(allPhases, milestoneName);

      // Build assertion objects from IDs (minimal: the worker reads the contract for details)
      const assertions: ContractAssertion[] = assertionIds.map((id) => ({
        id,
        title: id, // Title will be the ID itself; the worker reads the contract for full details
        description: `Verify assertion ${id} from the validation contract.`,
        evidence: "Examine code, run tests, check behavior",
      }));

      // Resolve validation-state.json path (project root)
      const validationStatePath = path.resolve(projectCwd, "validation-state.json");

      // Read prior results for re-validation support (VAL-EXEC-010)
      let priorResults: BehavioralValidationContext["priorResults"];
      const existingState = readValidationState(validationStatePath);
      if (existingState) {
        // Extract only the assertions relevant to this milestone
        const relevantPrior: NonNullable<BehavioralValidationContext["priorResults"]> = {};
        for (const id of assertionIds) {
          if (existingState.assertions[id]) {
            relevantPrior[id] = existingState.assertions[id];
          }
        }
        if (Object.keys(relevantPrior).length > 0) {
          priorResults = relevantPrior;
        }
      }

      return buildBehavioralValidationPrompt({
        milestoneName,
        assertions,
        validationStatePath,
        projectCwd,
        priorResults,
      });
    }

    // Default: use the standard work phase prompt
    return buildWorkPhasePrompt({ ...ctx, planContent: phase.description });
  };

  // MilestoneTracker: enables milestone-aware execution with auto-injection
  // of validation phases (scrutiny + behavioral) at milestone boundaries.
  // The tracker starts fresh — sealed milestones are tracked in-memory during
  // the execution loop run and prevent duplicate validation injection.
  const milestoneTracker = new MilestoneTracker();
  log.info("milestone tracker created for work loop", { workflowId });

  const loop = new ExecutionLoop({
    phaseProvider,
    promptBuilder,
    executor,
    emitter,
    config,
    ui,
    workflowId,
    workflowLabel: absPlanPath,
    statePersistence: persistence,
    approvalHandler,
    fileReferences,
    keyDecisions: state.keyDecisions,
    dispatcherOrchestrator: params.dispatcherOrchestrator,
    planContent,
    statePath,
    contextPath,
    budgetTracker: params.budgetTracker,
    budgetLimits: params.budgetLimits,
    contextIndexer: params.contextIndexer,
    evaluatorTransport: params.evaluatorTransport,
    onSessionName: params.onSessionName,
    logBaseDir: params.logBaseDir,
    milestoneTracker,
  });
  loop.setLoadedState(state);

  return {
    loop,
    shutdown: () => loop.requestShutdown(),
    getAccumulatedExtra: () => loop.getAccumulatedExtra(),
  };
}

// ---------------------------------------------------------------------------
// Generic loop configuration (plan, review, ship, debug, research)
// ---------------------------------------------------------------------------

interface GenericLoopParams {
  workflow: WorkflowType;
  workflowId: string;
  emitter: FlywheelEmitter;
  executor: PhaseExecutor;
  dispatcherOrchestrator?: DispatcherOrchestrator;
  config: FlywheelConfig;
  ui: IWorkflowUI;
  args: Record<string, string>;
  budgetTracker?: BudgetTracker;
  budgetLimits?: BudgetLimits;
  contextIndexer?: ContextIndexer;
  evaluatorTransport?: EvaluatorTransport;
  questionService?: QuestionService;
  interactiveOverrides?: { plan?: boolean; review?: boolean };
  onSessionName?: (name: string) => void;
  projectCwd: string;
  logBaseDir?: string;
}

function createGenericLoop(params: GenericLoopParams): StageLoopHandle {
  const { workflow, workflowId, emitter, executor, config, args, projectCwd } = params;

  const workflowDef = workflowRegistry[workflow];
  if (!workflowDef) {
    throw new Error(`Unknown workflow type: ${workflow}`);
  }

  const phaseProvider = new WorkflowDefinitionProvider(workflowDef);

  const promptBuilder: PromptBuilder = (phase, ctx) =>
    buildWorkflowPrompt(
      phase.index,
      workflowDef,
      args,
      ctx.previousResult,
      projectCwd,
      ctx.extra,
    );

  // Resolve onStepComplete hook based on workflow type.
  const isPlan = workflow === "plan";
  const isReview = workflow === "review";
  const isShip = workflow === "ship";
  const stageKey = workflow as "plan" | "review";
  const interactive =
    params.interactiveOverrides?.[stageKey] ?? config.interactive_consolidation ?? false;

  let onStepComplete: OnStepCompleteHook | undefined;
  if (isPlan) {
    onStepComplete = createPlanOnStepComplete(projectCwd, {
      questionService: params.questionService,
      interactive,
    });
  } else if (isReview) {
    onStepComplete = createReviewOnStepComplete({
      questionService: params.questionService,
      interactive,
    });
  } else if (isShip) {
    onStepComplete = createShipOnStepComplete(projectCwd);
  }

  // Resolve shouldSkipPhase hook based on workflow type.
  let shouldSkipPhase: ShouldSkipPhaseHook | undefined;
  if (isReview) {
    shouldSkipPhase = (phase, accumulatedExtra) => {
      if (phase.index === REVIEW_FIX_STEP_INDEX) {
        const hasFindings = accumulatedExtra.hasActionableFindings === true;
        if (!hasFindings) {
          log.info("skipping review fix step — no actionable findings (no P1/P2)", {
            phaseIndex: phase.index,
          });
          return true;
        }
      }
      return false;
    };
  }

  // Synthesize plan content from the workflow definition so the dispatcher
  // has context for prompt crafting. Without this, the dispatcher is skipped
  // because ExecutionLoop requires planContent to be non-empty.
  const syntheticPlanContent = workflowDef.steps
    .map((step, i) => `## Phase ${i + 1}: ${step.description}`)
    .join("\n\n");

  // Include the user's description/topic in the plan content for richer dispatcher context.
  const description = args.description || args.topic || "";
  const fullPlanContent = description
    ? `# ${workflowDef.name}: ${description}\n\n${syntheticPlanContent}`
    : `# ${workflowDef.name}\n\n${syntheticPlanContent}`;

  const loop = new ExecutionLoop({
    phaseProvider,
    promptBuilder,
    executor,
    emitter,
    config,
    ui: params.ui,
    workflowId,
    workflowLabel: workflowDef.name,
    onStepComplete,
    shouldSkipPhase,
    dispatcherOrchestrator: params.dispatcherOrchestrator,
    planContent: fullPlanContent,
    budgetTracker: params.budgetTracker,
    budgetLimits: params.budgetLimits,
    contextIndexer: params.contextIndexer,
    evaluatorTransport: params.evaluatorTransport,
    onSessionName: params.onSessionName,
    logBaseDir: params.logBaseDir,
  });

  return {
    loop,
    shutdown: () => loop.requestShutdown(),
    getAccumulatedExtra: () => loop.getAccumulatedExtra(),
  };
}

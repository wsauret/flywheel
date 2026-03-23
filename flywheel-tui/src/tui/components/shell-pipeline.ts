/**
 * Shell Pipeline — pipeline stage composition and stage runner factory.
 *
 * Contains `buildPipelineStages` (pure function to compute stages from
 * config) and `createShellStageRunner` (factory for the StageRunner used
 * by WorkflowPipeline when running within the shell).
 *
 * All workflow types flow through one code path via `createStageLoop()`.
 */

import { createFlywheelEmitter } from "../../events/event-bus";
import { createStageLoop } from "../../controller/stage-loop-factory";
import type { ExecutionLoop } from "../../controller/execution-loop";
import type { QuestionService } from "../../controller/question-service";
import type { FlywheelConfig } from "../../config/loader";
import type { WorkflowDeps } from "../../controller/workflow-deps";
import type { WorkflowSession } from "./workflow-session";
import type { BudgetTracker } from "../../session/budget-tracker";
import type { BudgetLimits } from "../../schemas/shared";
import type { ContextIndexer } from "../../memory/indexer";
import type { DispatcherTransport } from "../../dispatcher/transport";
import type {
  PipelineStage,
  PipelineStageResult,
  StageRunner,
  WorkflowType,
} from "../../controller/workflow-pipeline";

// ---------------------------------------------------------------------------
// Stage composition
// ---------------------------------------------------------------------------

/**
 * Build the pipeline stage array for a given entry workflow and config.
 *
 * Rules:
 *   - `/plan` with auto_chain → ["plan", "work", "review"] (+ "ship" if auto_ship)
 *   - `/work` with auto_chain → ["work", "review"] (+ "ship" if auto_ship)
 *   - Standalone (auto_chain false) or other workflows → null (no pipeline)
 *
 * Returns null when the command should run as a standalone workflow
 * (no pipeline wrapping needed).
 */
export function buildPipelineStages(
  workflow: string,
  config: FlywheelConfig,
): PipelineStage[] | null {
  if (!config.auto_chain) return null;

  // Only "plan" and "work" trigger pipeline mode
  if (workflow !== "plan" && workflow !== "work") return null;

  const stages: PipelineStage[] = [];

  if (workflow === "plan") {
    stages.push({ workflow: "plan" });
  }

  stages.push({ workflow: "work" });
  stages.push({ workflow: "review" });

  if (config.auto_ship) {
    stages.push({ workflow: "ship" });
  }

  return stages;
}

// ---------------------------------------------------------------------------
// Stage runner factory
// ---------------------------------------------------------------------------

export interface StageRunnerOptions {
  session: WorkflowSession;
  deps: WorkflowDeps;
  questionService?: QuestionService;
  interactiveOverrides?: { plan?: boolean; review?: boolean };
  budgetTracker?: BudgetTracker;
  budgetLimits?: BudgetLimits;
  /** Called when a new ExecutionLoop is created for a stage. Used to expose the loop for injection. */
  onLoopCreated?: (loop: ExecutionLoop) => void;
  /** Context indexer for conventions/standards/learnings metadata. Caller manages lifecycle. */
  contextIndexer?: ContextIndexer;
  /** Dispatcher transport — wired into every stage's ExecutionLoop. */
  dispatcherTransport?: DispatcherTransport;
  /** Called when the dispatcher generates a short session name (first phase of first stage). */
  onSessionName?: (name: string) => void;
}

/**
 * Create a StageRunner that executes stages within a single WorkflowSession.
 *
 * All workflow types (including "work") flow through `createStageLoop()` —
 * one factory, one code path. The dispatcher is wired when `dispatcherTransport`
 * is provided.
 */
export function createShellStageRunner(opts: StageRunnerOptions): StageRunner {
  const {
    session,
    deps,
    questionService,
    interactiveOverrides,
    budgetTracker,
    budgetLimits,
    onLoopCreated,
    contextIndexer,
    dispatcherTransport,
    onSessionName,
  } = opts;

  return async (
    stage: PipelineStage,
    args: Record<string, string>,
    signal: AbortSignal,
  ): Promise<PipelineStageResult> => {
    // Validate work stage has a planPath
    if (stage.workflow === "work" && !args.planPath) {
      return {
        workflow: "work",
        completed: false,
        reason: "No plan file path available. The plan stage may not have written a plan file to disk.",
      };
    }

    try {
      const handle = createStageLoop({
        workflow: stage.workflow as WorkflowType,
        args,
        config: deps.config,
        spawner: deps.spawner,
        engine: deps.engine,
        ui: session.adapter,
        eventBus: session.eventBus,
        budgetTracker,
        budgetLimits,
        contextIndexer,
        dispatcherTransport,
        questionService,
        interactiveOverrides,
        onSessionName,
      });

      // Expose the loop for mid-execution stdin injection
      onLoopCreated?.(handle.loop);

      // Respect abort signal
      signal.addEventListener("abort", () => handle.shutdown());

      const result = await handle.loop.run();

      // Extract accumulated data (e.g., planFilePath from plan workflow)
      const extra = handle.getAccumulatedExtra();
      const planFilePath = extra.planFilePath as string | undefined;
      const planFileWarning = extra.planFileWarning as string | undefined;

      // Surface plan extraction results as system messages
      if (stage.workflow === "plan") {
        const emitter = createFlywheelEmitter(session.eventBus);
        const workflowId = `${stage.workflow}-pipeline`;
        if (planFileWarning) {
          emitter.workerOutput(workflowId, "stderr", `\u26A0 ${planFileWarning}\n`);
        }
        if (planFilePath) {
          emitter.workerOutput(workflowId, "stderr", `\u2713 Extracted plan path: ${planFilePath}\n`);
        }
      }

      return {
        workflow: stage.workflow as WorkflowType,
        completed: result.completed,
        reason: result.reason,
        planPath: planFilePath,
      };
    } catch (err) {
      return {
        workflow: stage.workflow as WorkflowType,
        completed: false,
        reason: String(err),
      };
    }
  };
}

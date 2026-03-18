/**
 * Shell Pipeline — extracted pipeline logic for flywheel-shell.
 *
 * Contains `buildPipelineStages` (pure function to compute stages from
 * config) and `createShellStageRunner` (factory for the StageRunner used
 * by WorkflowPipeline when running within the shell).
 *
 * Extracted so the logic is testable without JSX or OpenTUI runtime.
 */

import { createFlywheelEmitter } from "../../events/event-bus";
import { ExecutionLoop, type PromptBuilder } from "../../controller/execution-loop";
import { WorkflowDefinitionProvider } from "../../controller/workflow-def-provider";
import { PhaseExecutor } from "../../controller/phase-executor";
import { WorkController } from "../../controller/work";
import {
  workflowRegistry,
  buildWorkflowPrompt,
} from "../../workflows/index";
import { createPlanOnStepComplete } from "../../workflows/plan-output-extractor";
import type { FlywheelConfig } from "../../config/loader";
import type { WorkflowDeps } from "../../controller/workflow-deps";
import type { WorkflowSession } from "./workflow-session";
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

/**
 * Create a StageRunner that executes stages within a single WorkflowSession.
 *
 * Decision #2: the pipeline runs ALL stages within a SINGLE session.
 * The stage runner does NOT create new sessions. It creates ExecutionLoop
 * or WorkController instances that connect to the same EventBus/adapter.
 *
 * For "work" stages: uses WorkController (plan file-based execution).
 * For generic stages (plan, review, ship, debug, research): uses ExecutionLoop
 * with WorkflowDefinitionProvider.
 */
export function createShellStageRunner(
  session: WorkflowSession,
  deps: WorkflowDeps,
): StageRunner {
  return async (
    stage: PipelineStage,
    args: Record<string, string>,
    signal: AbortSignal,
  ): Promise<PipelineStageResult> => {
    // ── Work stage: use WorkController ──
    if (stage.workflow === "work") {
      if (!args.planPath) {
        return {
          workflow: "work",
          completed: false,
          reason: "No plan file path available. The plan stage may not have written a plan file to disk.",
        };
      }
      const controller = new WorkController({
        config: deps.config,
        spawner: deps.spawner,
        engine: deps.engine,
        ui: session.adapter,
        eventBus: session.eventBus,
      });

      // Respect abort signal
      signal.addEventListener("abort", () => {
        controller.shutdown().catch(() => {});
      });

      try {
        const result = await controller.run(args.planPath);
        return {
          workflow: "work",
          completed: result.completed,
          reason: result.reason,
        };
      } catch (err) {
        return {
          workflow: "work",
          completed: false,
          reason: String(err),
        };
      }
    }

    // ── Generic workflow (plan, review, ship, debug, research) ──
    const workflow = workflowRegistry[stage.workflow];
    if (!workflow) {
      return {
        workflow: stage.workflow,
        completed: false,
        reason: `Unknown workflow: ${stage.workflow}`,
      };
    }

    // Use the session's unified event bus — not a per-stage bus.
    // The adapter is already connected to session.eventBus.
    const eventBus = session.eventBus;
    const emitter = createFlywheelEmitter(eventBus);

    const workflowId = `${stage.workflow}-pipeline`;

    const executor = new PhaseExecutor({
      spawner: deps.spawner,
      emitter,
      config: deps.config,
      engine: deps.engine,
      workflowId,
    });

    const promptBuilder: PromptBuilder = (phase, ctx) =>
      buildWorkflowPrompt(
        phase.index,
        workflow,
        args,
        ctx.previousResult,
        deps.config.project_cwd,
        ctx.extra,
      );

    const phaseProvider = new WorkflowDefinitionProvider(workflow);

    // For plan: install onStepComplete and skipTruncation
    const isPlan = stage.workflow === "plan";
    const projectCwd = deps.config.project_cwd || process.cwd();
    const onStepComplete = isPlan
      ? createPlanOnStepComplete(projectCwd)
      : undefined;

    const loop = new ExecutionLoop({
      phaseProvider,
      promptBuilder,
      executor,
      emitter,
      config: deps.config,
      ui: session.adapter,
      workflowId,
      workflowLabel: workflow.name,
      onStepComplete,
      skipTruncation: isPlan,
    });

    // Respect abort signal
    signal.addEventListener("abort", () => loop.requestShutdown());

    try {
      const result = await loop.run();

      // For plan workflows, check if planFilePath was captured
      const extra = loop.getAccumulatedExtra();
      const planFilePath = extra.planFilePath as string | undefined;
      const planFileWarning = extra.planFileWarning as string | undefined;

      // Surface plan extraction results as system messages
      if (isPlan) {
        if (planFileWarning) {
          emitter.workerOutput(workflowId, "stderr", `⚠ ${planFileWarning}\n`);
        }
        if (planFilePath) {
          emitter.workerOutput(workflowId, "stderr", `✓ Extracted plan path: ${planFilePath}\n`);
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

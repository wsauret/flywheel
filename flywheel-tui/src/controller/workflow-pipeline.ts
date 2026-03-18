/**
 * WorkflowPipeline — sequences workflow stages (plan -> work -> review -> ship)
 * with configurable gates between stages.
 *
 * Decision #2: Single session spans the entire pipeline (no createWorkflowSession
 * between stages). Emits pipeline:stage-transition events for TUI updates.
 *
 * Decision #4: Pipeline gates use the same QuestionService as question resolution.
 *
 * Decision #13: Lives in src/controller/ — orchestrates ExecutionLoop/WorkController
 * instances and gates.
 */

import type { EventBus } from "../events/event-bus";
import type { FlywheelConfig } from "../config/loader";
import type { QuestionService, QuestionRejectedError } from "./question-service";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid workflow types (matches action-dispatcher.ts WorkflowType). */
export type WorkflowType = "work" | "plan" | "review" | "ship" | "debug" | "research";

export interface PipelineStage {
  workflow: WorkflowType;
  /** If true, present a gate question before proceeding to the next stage. */
  gateBeforeNext?: boolean;
}

export interface PipelineStageResult {
  workflow: WorkflowType;
  completed: boolean;
  planPath?: string;
  reason?: string;
}

export interface PipelineResult {
  completed: boolean;
  stagesCompleted: number;
  stagesTotal: number;
  reason?: string;
  stageResults: PipelineStageResult[];
}

/**
 * Function that executes a single pipeline stage.
 * Injected for testability — production code provides a runner that
 * creates ExecutionLoop or WorkController internally.
 */
export type StageRunner = (
  stage: PipelineStage,
  args: Record<string, string>,
  signal: AbortSignal,
) => Promise<PipelineStageResult>;

export interface PipelineOptions {
  stages: PipelineStage[];
  args: Record<string, string>;
  config: FlywheelConfig;
  stageRunner: StageRunner;
  questionService: QuestionService;
  eventBus: EventBus;
  onStageComplete?: (
    workflow: WorkflowType,
    result: PipelineStageResult,
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Gate answer constants
// ---------------------------------------------------------------------------

const GATE_CONTINUE = "Continue";
const GATE_STOP = "Stop";
const GATE_PAUSE = "Pause";

// ---------------------------------------------------------------------------
// WorkflowPipeline
// ---------------------------------------------------------------------------

export class WorkflowPipeline {
  private readonly stages: PipelineStage[];
  private readonly args: Record<string, string>;
  private readonly stageRunner: StageRunner;
  private readonly questionService: QuestionService;
  private readonly eventBus: EventBus;
  private readonly onStageComplete?: PipelineOptions["onStageComplete"];
  private readonly abortController = new AbortController();
  private readonly pipelineId = crypto.randomUUID();
  private hasRun = false;

  constructor(options: PipelineOptions) {
    this.stages = options.stages;
    this.args = { ...options.args };
    this.stageRunner = options.stageRunner;
    this.questionService = options.questionService;
    this.eventBus = options.eventBus;
    this.onStageComplete = options.onStageComplete;
  }

  /**
   * Run all pipeline stages sequentially. Returns a PipelineResult.
   * Can only be called once.
   */
  async run(): Promise<PipelineResult> {
    if (this.hasRun) {
      throw new Error("Pipeline can only be run once");
    }
    this.hasRun = true;

    const stageResults: PipelineStageResult[] = [];
    let stagesCompleted = 0;

    // Empty stages
    if (this.stages.length === 0) {
      return {
        completed: true,
        stagesCompleted: 0,
        stagesTotal: 0,
        stageResults: [],
      };
    }

    // Emit pipeline:started
    this.eventBus.emit({
      type: "pipeline:started",
      pipelineId: this.pipelineId,
      stages: this.stages.map((s) => s.workflow),
      timestamp: now(),
    });

    // Mutable args that accumulate data from stage results (e.g. planPath)
    const currentArgs = { ...this.args };

    for (let i = 0; i < this.stages.length; i++) {
      const stage = this.stages[i];

      // Check abort before starting stage
      if (this.abortController.signal.aborted) {
        this.eventBus.emit({
          type: "pipeline:failed",
          pipelineId: this.pipelineId,
          reason: "Pipeline was shut down",
          stagesCompleted,
          timestamp: now(),
        });
        return {
          completed: false,
          stagesCompleted,
          stagesTotal: this.stages.length,
          reason: "Pipeline was shut down",
          stageResults,
        };
      }

      // Emit stage-transition event (between stages, not before the first)
      if (i > 0) {
        this.eventBus.emit({
          type: "pipeline:stage-transition",
          pipelineId: this.pipelineId,
          from: this.stages[i - 1].workflow,
          to: stage.workflow,
          timestamp: now(),
        });
      }

      // Run the stage
      const result = await this.stageRunner(
        stage,
        currentArgs,
        this.abortController.signal,
      );
      stageResults.push(result);

      // Call onStageComplete callback
      if (this.onStageComplete) {
        await this.onStageComplete(stage.workflow, result);
      }

      if (!result.completed) {
        // Stage failed — halt pipeline
        this.eventBus.emit({
          type: "pipeline:failed",
          pipelineId: this.pipelineId,
          reason: result.reason ?? `${stage.workflow} stage failed`,
          stagesCompleted,
          timestamp: now(),
        });
        return {
          completed: false,
          stagesCompleted,
          stagesTotal: this.stages.length,
          reason: result.reason ?? `${stage.workflow} stage failed`,
          stageResults,
        };
      }

      stagesCompleted++;

      // Thread stage result data into args for next stage
      if (result.planPath) {
        currentArgs.planPath = result.planPath;
      }

      // Gate: ask user whether to continue (only if there IS a next stage)
      const isLastStage = i === this.stages.length - 1;
      if (stage.gateBeforeNext && !isLastStage) {
        const nextStage = this.stages[i + 1];
        const gateDecision = await this.presentGate(nextStage.workflow);

        if (gateDecision === "stop") {
          this.eventBus.emit({
            type: "pipeline:failed",
            pipelineId: this.pipelineId,
            reason: "User chose to stop at gate",
            stagesCompleted,
            timestamp: now(),
          });
          return {
            completed: false,
            stagesCompleted,
            stagesTotal: this.stages.length,
            reason: "User chose to stop at gate",
            stageResults,
          };
        }

        if (gateDecision === "pause") {
          this.eventBus.emit({
            type: "pipeline:failed",
            pipelineId: this.pipelineId,
            reason: "User chose to pause at gate",
            stagesCompleted,
            timestamp: now(),
          });
          return {
            completed: false,
            stagesCompleted,
            stagesTotal: this.stages.length,
            reason: "User chose to pause at gate",
            stageResults,
          };
        }

        if (gateDecision === "dismissed") {
          this.eventBus.emit({
            type: "pipeline:failed",
            pipelineId: this.pipelineId,
            reason: "Gate question was dismissed",
            stagesCompleted,
            timestamp: now(),
          });
          return {
            completed: false,
            stagesCompleted,
            stagesTotal: this.stages.length,
            reason: "Gate question was dismissed",
            stageResults,
          };
        }

        if (gateDecision === "aborted") {
          this.eventBus.emit({
            type: "pipeline:failed",
            pipelineId: this.pipelineId,
            reason: "Pipeline was shut down during gate",
            stagesCompleted,
            timestamp: now(),
          });
          return {
            completed: false,
            stagesCompleted,
            stagesTotal: this.stages.length,
            reason: "Pipeline was shut down during gate",
            stageResults,
          };
        }

        // gateDecision === "continue" — proceed to next stage
      }
    }

    // All stages completed successfully
    this.eventBus.emit({
      type: "pipeline:completed",
      pipelineId: this.pipelineId,
      stagesCompleted,
      timestamp: now(),
    });

    return {
      completed: true,
      stagesCompleted,
      stagesTotal: this.stages.length,
      stageResults,
    };
  }

  /**
   * Request graceful shutdown. Aborts the current stage and any pending gates.
   */
  requestShutdown(): void {
    this.abortController.abort();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Present a gate question to the user via QuestionService.
   * Returns the user's decision: "continue", "stop", "pause", "dismissed", or "aborted".
   */
  private async presentGate(
    nextWorkflow: string,
  ): Promise<"continue" | "stop" | "pause" | "dismissed" | "aborted"> {
    // Race between the question and an abort signal
    const questionPromise = this.questionService.ask([
      {
        question: `Stage completed. Continue to ${nextWorkflow}?`,
        header: "Pipeline gate",
        options: [
          {
            label: `${GATE_CONTINUE} to ${nextWorkflow}`,
            description: `Proceed to the ${nextWorkflow} stage`,
          },
          {
            label: `${GATE_STOP} here`,
            description: "Stop the pipeline after this stage",
          },
          {
            label: `${GATE_PAUSE} (resume later)`,
            description: "Pause the pipeline; resume later",
          },
        ],
      },
    ]);

    // If already aborted, the question was asked but we should handle it
    if (this.abortController.signal.aborted) {
      // Reject the pending question
      const pending = this.questionService.list();
      for (const p of pending) {
        this.questionService.reject(p.id);
      }
      return "aborted";
    }

    // Race question against abort
    const abortPromise = new Promise<"aborted">((resolve) => {
      if (this.abortController.signal.aborted) {
        resolve("aborted");
        return;
      }
      this.abortController.signal.addEventListener("abort", () => {
        // Reject the pending question to unblock
        const pending = this.questionService.list();
        for (const p of pending) {
          this.questionService.reject(p.id);
        }
        resolve("aborted");
      });
    });

    try {
      const result = await Promise.race([questionPromise, abortPromise]);

      if (result === "aborted") return "aborted";

      // result is QuestionAnswer[] — array of answers, one per question
      const answers = result as string[][];
      const answer = answers[0]?.[0]?.toLowerCase() ?? "";

      if (answer.includes("stop")) return "stop";
      if (answer.includes("pause")) return "pause";
      return "continue";
    } catch {
      // QuestionRejectedError — user dismissed
      return "dismissed";
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString();
}

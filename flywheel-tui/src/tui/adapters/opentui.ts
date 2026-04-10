/**
 * OpenTUI Adapter — translates FlywheelEvent → registry entry updates.
 *
 * Pipeline: subprocess stdout → NDJSONParser → StructuredEventParser
 *   → StructuredOutputBuilder → updateEntry({ outputBlocks })
 *
 * Dispatcher/evaluator NDJSON handling is delegated to NdjsonPipeline.
 */

import { assertNever, type FlywheelEvent } from "../../infra/events.js";
import { BaseEventConsumer } from "../../infra/base-event-consumer";
import type { WorkflowSessionEntry } from "../../orchestration/session-registry";
import { createOutputPipeline, type OutputPipeline } from "../../orchestration/output-pipeline";
import { NdjsonPipeline } from "./ndjson-pipeline.js";
import { Log } from "../../infra/log.js";

const STEP_BOUNDARY_PREFIX = "[step-boundary]";

export interface OpenTUIAdapterOptions {
  updateEntry: (patch: Partial<WorkflowSessionEntry>) => void;
  /** Engine metadata — used to configure engine-specific adapter behaviour (e.g. synthetic thinking timer). */
  engineMetadata?: import("../../orchestration/engines/core/types").EngineMetadata;
}

const log = Log.create({ service: "opentui-adapter" });

export class OpenTUIAdapter extends BaseEventConsumer {
  private updateEntry: (patch: Partial<WorkflowSessionEntry>) => void;

  /** Current engine ID for routing events. Updated per subprocess:output event. */
  private currentEngineId: string | undefined;

  // ── Structured pipeline (shared factory) ──

  private outputPipeline: OutputPipeline;

  /** Synthetic thinking timer for engines that batch thinking blocks. */
  private syntheticThinkingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly syntheticThinkingMs: number | undefined;

  /** Dispatcher/evaluator NDJSON pipeline (block tracking + activity extraction). */
  private ndjsonPipeline: NdjsonPipeline;

  constructor(options: OpenTUIAdapterOptions) {
    super();
    this.updateEntry = options.updateEntry;
    this.syntheticThinkingMs = options.engineMetadata?.syntheticThinkingMs;

    // Initialize structured pipeline via shared factory
    this.outputPipeline = createOutputPipeline({
      onModelActivityChange: (activity) => {
        if (this.syntheticThinkingTimer) {
          clearTimeout(this.syntheticThinkingTimer);
          this.syntheticThinkingTimer = null;
        }
        this.updateEntry({ modelActivity: activity });
        if (this.syntheticThinkingMs !== undefined && (activity === "tool_executing" || activity === "generating")) {
          this.syntheticThinkingTimer = setTimeout(() => {
            this.syntheticThinkingTimer = null;
            this.updateEntry({ modelActivity: "thinking" });
          }, this.syntheticThinkingMs);
        }
      },
    });

    // Initialize dispatcher/evaluator NDJSON pipeline
    this.ndjsonPipeline = new NdjsonPipeline(this.outputPipeline.builder);

    // Wire NDJSONParser events to StructuredEventParser (factory does NOT set this)
    this.outputPipeline.parser.onEvent = (event) => {
      this.outputPipeline.eventParser.dispatch(event, this.currentEngineId);
    };

    // Keep the factory's default onRawText (pushes text blocks)

    this.outputPipeline.startFlush(() => this.flushBlocks());
  }

  /** Clean up intervals on disconnect. */
  override disconnect(): void {
    super.disconnect();
    if (this.syntheticThinkingTimer !== null) {
      clearTimeout(this.syntheticThinkingTimer);
      this.syntheticThinkingTimer = null;
    }
    this.outputPipeline.dispose();
  }

  protected handleEvent(event: FlywheelEvent): void {
    switch (event.type) {
      case "subprocess:output":
        this.handleSubprocessOutput(event.stream, event.data, event.timestamp, event.engineId);
        break;

      case "subprocess:spawned":
        log.debug(`Subprocess spawned for step ${event.stepIndex}`, { step: event.stepIndex });
        this.outputPipeline.builder.notifyThinkingStarted(event.timestamp);
        break;

      case "dispatcher:invoked":
        this.ndjsonPipeline.startDispatcher();
        // Flush deferred to 16ms interval
        break;

      case "dispatcher:completed": {
        const warnings = event.decision.warnings;
        const warningText = warnings && warnings.length > 0
          ? ` (${warnings.length} warning${warnings.length > 1 ? "s" : ""})`
          : "";
        this.ndjsonPipeline.completeDispatcher(`Prompt ready${warningText}`);
        // Flush deferred to 16ms interval
        break;
      }

      case "dispatcher:failed":
        this.ndjsonPipeline.failDispatcher(event.reason);
        // Flush deferred to 16ms interval
        break;

      case "evaluator:invoked":
        this.ndjsonPipeline.startEvaluator();
        // Flush deferred to 16ms interval
        break;

      case "evaluator:completed": {
        const verdict = event.result.passed ? "Passed" : "Needs revision";
        const reasoning = event.result.reasoning ? ` \u2014 ${event.result.reasoning}` : "";
        this.ndjsonPipeline.completeEvaluator(`${verdict}${reasoning}`);
        // Flush deferred to 16ms interval
        break;
      }

      case "evaluator:failed":
        this.ndjsonPipeline.failEvaluator(event.reason);
        // Flush deferred to 16ms interval
        break;

      case "evaluator:revision-requested":
        this.ndjsonPipeline.completeEvaluator(`Needs revision (attempt ${event.revisionAttempt}/${event.maxRevisions})`);
        // Flush deferred to 16ms interval
        break;

      case "question:asked":
      case "question:replied":
      case "question:rejected":
        break;

      case "budget:metrics-changed":
        // Metrics updates handled by workflow-runner's typed subscription
        break;

      case "budget:exhausted":
        log.warn("Budget exhausted", { workflowId: event.workflowId, reason: event.reason });
        this.pushSystemText(`\u26a0 Budget exhausted: ${event.reason}\n`, event.timestamp);
        break;

      case "subprocess:injected":
        log.info("Subprocess stdin injected", { workflowId: event.workflowId, messageLength: event.message.length });
        this.outputPipeline.builder.pushUserMessage(event.message, event.timestamp, false, true);
        this.outputPipeline.builder.notifyThinkingStarted(event.timestamp);
        // Flush deferred to 16ms interval
        break;

      case "dispatcher:output":
        if (event.stream === "stdout") {
          this.ndjsonPipeline.dispatcherParser.write(event.data);
          // Flush deferred to 16ms interval
        }
        break;

      case "evaluator:output":
        if (event.stream === "stdout") {
          this.ndjsonPipeline.evaluatorParser.write(event.data);
          // Flush deferred to 16ms interval
        }
        break;

      case "queue:initialized":
        log.info("Queue initialized", { workflowId: event.workflowId, steps: event.stepIds.length });
        break;

      case "queue:completed":
        log.info("Queue completed", { workflowId: event.workflowId, stepsCompleted: event.stepsCompleted });
        this.flushBlocks();
        this.updateEntry({ modelActivity: "idle" });
        break;

      case "queue:failed":
        log.warn("Queue failed", { workflowId: event.workflowId, reason: event.reason, stepsCompleted: event.stepsCompleted });
        this.flushBlocks();
        this.updateEntry({ modelActivity: "idle" });
        break;

      case "queue:step-started":
        log.info("Queue step started", { workflowId: event.workflowId, stepId: event.stepId, stepType: event.stepType, stepTitle: event.stepTitle });
        this.outputPipeline.builder.resetTracking();
        this.pushSystemText(
          `${STEP_BOUNDARY_PREFIX} ${this.formatStepBoundaryLabel(event.stepType, event.stepTitle)}\n`,
          event.timestamp,
        );
        // Step state is handled by the runner's typed EventBus subscriptions
        break;

      case "queue:step-completed":
        log.info("Queue step completed", { workflowId: event.workflowId, stepId: event.stepId, stepType: event.stepType, stepTitle: event.stepTitle });
        // Step state is handled by the runner's typed EventBus subscriptions
        break;

      case "queue:step-failed":
        log.warn("Queue step failed", { workflowId: event.workflowId, stepId: event.stepId, stepType: event.stepType, reason: event.reason });
        // Step state is handled by the runner's typed EventBus subscriptions
        break;

      // Subprocess NDJSON events — handled by EventBus subscribers, no TUI rendering needed
      case "subprocess:ndjson":
        break;

      // Trace events — handled by TraceCollector, no TUI rendering needed
      case "trace:tool-started":
      case "trace:tool-completed":
      case "trace:subagent-started":
      case "trace:subagent-completed":
        break;

      default:
        assertNever(event);
    }
  }

  /** Push a system message through the block pipeline and flush. */
  private pushSystemText(text: string, timestamp: number): void {
    this.outputPipeline.builder.pushSystemMessage(text, timestamp);
    this.flushBlocks();
  }

  private formatStepBoundaryLabel(stepType: string, stepTitle: string): string {
    return `${stepType.toUpperCase()} · ${stepTitle}`;
  }

  /** Route subprocess output: stderr → system text, stdout → NDJSON pipeline. */
  private handleSubprocessOutput(
    stream: "stdout" | "stderr",
    data: string,
    timestamp: number,
    engineId?: string,
  ): void {
    if (stream === "stderr") {
      this.pushSystemText(data, timestamp);
      return;
    }

    if (engineId !== undefined) {
      this.currentEngineId = engineId;
    }

    // Feed chunk to NDJSONParser (handles line buffering, ANSI stripping,
    // CRLF normalization, garbage-prefix extraction).
    // The 16ms flush interval handles pushing blocks to the store.
    this.outputPipeline.parser.write(data);
  }

  /**
   * Flush builder blocks to the registry if the builder has pending changes.
   */
  private flushBlocks(): void {
    if (this.outputPipeline.builder.hasChanged()) {
      this.updateEntry({ outputBlocks: this.outputPipeline.builder.getBlocks() });
    }
  }

}

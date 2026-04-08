/**
 * OpenTUI Adapter — translates FlywheelEvent → UIActions (store mutations).
 *
 * Pipeline: subprocess stdout → NDJSONParser → StructuredEventParser
 *   → StructuredOutputBuilder → setOutputBlocks
 *
 * Dispatcher/evaluator NDJSON handling is delegated to NdjsonPipeline.
 */

import { assertNever, type FlywheelEvent } from "../../infra/events.js";
import type { AdapterType } from "./types";
import { BaseUIAdapter } from "./base";
import type { UIActions } from "../routes/work/context/ui-state/types";
import { NDJSONParser } from "../../orchestration/engines/subprocess/ndjson-parser";
import { StructuredOutputBuilder } from "../../infra/output/structured-output-builder";
import { StructuredEventParser } from "../../infra/output/structured-event-parser";
import { NdjsonPipeline } from "./ndjson-pipeline.js";
import { Log } from "../../infra/log.js";

/** Flush interval for batched block updates (ms). */
const FLUSH_INTERVAL_MS = 16;

const STEP_BOUNDARY_PREFIX = "[step-boundary]";

export interface OpenTUIAdapterOptions {
  actions: UIActions;
  /** Engine metadata — used to configure engine-specific adapter behaviour (e.g. synthetic thinking timer). */
  engineMetadata?: import("../../orchestration/engines/core/types").EngineMetadata;
}

const log = Log.create({ service: "opentui-adapter" });

export class OpenTUIAdapter extends BaseUIAdapter {
  readonly adapterType: AdapterType = "opentui";
  private actions: UIActions;

  /** When true, pass raw output without NDJSON parsing */
  private _rawMode = false;

  /** Current engine ID for routing events. Updated per subprocess:output event. */
  private currentEngineId: string | undefined;

  // ── Structured pipeline components ──

  private ndjsonParser: NDJSONParser;
  private builder: StructuredOutputBuilder;
  private eventParser: StructuredEventParser;

  /** Interval handle for batched flush. */
  private flushInterval: ReturnType<typeof setInterval> | null = null;

  /** Synthetic thinking timer for engines that batch thinking blocks. */
  private syntheticThinkingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly syntheticThinkingMs: number | undefined;

  /** Dispatcher/evaluator NDJSON pipeline (block tracking + activity extraction). */
  private pipeline: NdjsonPipeline;

  constructor(options: OpenTUIAdapterOptions) {
    super();
    this.actions = options.actions;
    this.syntheticThinkingMs = options.engineMetadata?.syntheticThinkingMs;

    // Initialize structured pipeline
    this.builder = new StructuredOutputBuilder();
    this.eventParser = new StructuredEventParser({ builder: this.builder });
    this.ndjsonParser = new NDJSONParser();

    // Initialize dispatcher/evaluator NDJSON pipeline
    this.pipeline = new NdjsonPipeline(this.builder);

    // Wire builder → model activity tracking + synthetic thinking timer
    this.builder.onModelActivityChange = (activity) => {
      if (this.syntheticThinkingTimer) {
        clearTimeout(this.syntheticThinkingTimer);
        this.syntheticThinkingTimer = null;
      }
      this.actions.setModelActivity(activity);
      if (this.syntheticThinkingMs !== undefined && (activity === "tool_executing" || activity === "generating")) {
        this.syntheticThinkingTimer = setTimeout(() => {
          this.syntheticThinkingTimer = null;
          this.actions.setModelActivity("thinking");
        }, this.syntheticThinkingMs);
      }
    };

    // Wire NDJSONParser events to StructuredEventParser
    this.ndjsonParser.onEvent = (event) => {
      this.eventParser.dispatch(event, this.currentEngineId);
    };

    // Raw text lines (non-JSON) → push as text blocks
    this.ndjsonParser.onRawText = (text) => {
      if (text.trim().length > 0) {
        this.builder.pushText(text + "\n", Date.now());
      }
    };

    this.flushInterval = setInterval(() => {
      this.flushBlocks();
    }, FLUSH_INTERVAL_MS);
  }

  /** Toggle raw output mode. Returns the new state. */
  toggleRawMode(): boolean {
    this._rawMode = !this._rawMode;
    return this._rawMode;
  }

  /** Check if raw mode is enabled. */
  get rawMode(): boolean {
    return this._rawMode;
  }

  /** Clean up intervals on disconnect. */
  override disconnect(): void {
    super.disconnect();
    if (this.flushInterval !== null) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    if (this.syntheticThinkingTimer !== null) {
      clearTimeout(this.syntheticThinkingTimer);
      this.syntheticThinkingTimer = null;
    }
    this.builder.dispose();
  }

  protected handleEvent(event: FlywheelEvent): void {
    switch (event.type) {
      case "subprocess:output":
        this.handleSubprocessOutput(event.stream, event.data, event.timestamp, event.engineId);
        break;

      case "subprocess:retrying":
        this.pushSystemText(`↻ Retrying (${event.attempt}/${event.maxAttempts}): ${event.reason}\n`, event.timestamp);
        break;

      case "approval:requested":
        this.actions.setApprovalPending(event.description);
        break;

      case "approval:received":
        this.actions.clearApproval();
        break;

      case "subprocess:spawned":
        log.debug(`Subprocess spawned for step ${event.stepIndex}`, { step: event.stepIndex });
        break;

      case "subprocess:completed":
        log.debug("Subprocess finished");
        break;

      case "subprocess:failed":
        this.pushSystemText(`◉ Subprocess failed: ${event.failure.message}\n`, event.timestamp);
        break;

      case "dispatcher:invoked":
        this.pipeline.startDispatcher();
        this.flushBlocks();
        break;

      case "dispatcher:completed": {
        const warnings = event.decision.warnings;
        const warningText = warnings && warnings.length > 0
          ? ` (${warnings.length} warning${warnings.length > 1 ? "s" : ""})`
          : "";
        this.pipeline.completeDispatcher(`Prompt ready${warningText}`);
        this.flushBlocks();
        break;
      }

      case "dispatcher:failed":
        this.pipeline.failDispatcher(event.reason);
        this.flushBlocks();
        break;

      case "evaluator:invoked":
        this.pipeline.startEvaluator();
        this.flushBlocks();
        break;

      case "evaluator:completed": {
        const verdict = event.result.passed ? "Passed" : "Needs revision";
        const reasoning = event.result.reasoning ? ` — ${event.result.reasoning}` : "";
        this.pipeline.completeEvaluator(`${verdict}${reasoning}`);
        this.flushBlocks();
        break;
      }

      case "evaluator:failed":
        this.pipeline.failEvaluator(event.reason);
        this.flushBlocks();
        break;

      case "evaluator:revision-requested":
        this.pipeline.completeEvaluator(`Needs revision (attempt ${event.revisionAttempt}/${event.maxRevisions})`);
        this.flushBlocks();
        break;

      case "question:asked":
      case "question:replied":
      case "question:rejected":
        break;

      case "budget:warning":
        log.info("Budget warning", { metric: event.metric, used: event.used, limit: event.limit, remaining: event.remaining });
        break;

      case "budget:exhausted":
        log.warn("Budget exhausted", { workflowId: event.workflowId, reason: event.reason });
        this.pushSystemText(`⚠ Budget exhausted: ${event.reason}\n`, event.timestamp);
        break;

      case "subprocess:injected":
        log.info("Subprocess stdin injected", { workflowId: event.workflowId, messageLength: event.message.length });
        this.builder.pushUserMessage(event.message, new Date(event.timestamp).getTime() || Date.now(), false, true);
        this.flushBlocks();
        break;

      case "dispatcher:output":
        if (event.stream === "stdout") {
          this.pipeline.dispatcherParser.write(event.data);
          this.flushBlocks();
        }
        break;

      case "evaluator:output":
        if (event.stream === "stdout") {
          this.pipeline.evaluatorParser.write(event.data);
          this.flushBlocks();
        }
        break;

      case "queue:initialized":
        log.info("Queue initialized", { workflowId: event.workflowId, steps: event.stepIds.length });
        break;

      case "queue:completed":
        log.info("Queue completed", { workflowId: event.workflowId, stepsCompleted: event.stepsCompleted });
        this.flushBlocks();
        this.actions.setModelActivity("idle");
        this.actions.stopWorkflow("completed");
        break;

      case "queue:failed":
        log.warn("Queue failed", { workflowId: event.workflowId, reason: event.reason, stepsCompleted: event.stepsCompleted });
        this.flushBlocks();
        this.actions.setModelActivity("idle");
        this.actions.setError(event.reason);
        break;

      case "queue:step-started":
        log.info("Queue step started", { workflowId: event.workflowId, stepId: event.stepId, stepType: event.stepType, stepTitle: event.stepTitle });
        this.builder.resetTracking();
        this.pushSystemText(
          `${STEP_BOUNDARY_PREFIX} ${this.formatStepBoundaryLabel(event.stepType, event.stepTitle)}\n`,
          event.timestamp,
        );
        this.actions.startQueueStep(event.stepId);
        break;

      case "queue:step-completed":
        log.info("Queue step completed", { workflowId: event.workflowId, stepId: event.stepId, stepType: event.stepType, stepTitle: event.stepTitle });
        this.actions.completeQueueStep(event.stepId);
        break;

      case "queue:step-failed":
        log.warn("Queue step failed", { workflowId: event.workflowId, stepId: event.stepId, stepType: event.stepType, reason: event.reason });
        this.actions.failQueueStep(event.stepId, event.reason);
        break;

      case "queue:step-inserted":
        log.info("Queue step inserted", { workflowId: event.workflowId, stepId: event.stepId, stepType: event.stepType, afterStepId: event.afterStepId });
        this.actions.insertQueueStep(
          { id: event.stepId, type: event.stepType, title: event.stepTitle, status: "pending" },
          event.afterStepId,
        );
        break;

      case "queue:step-removed":
        log.info("Queue step removed", { workflowId: event.workflowId, stepId: event.stepId, stepType: event.stepType });
        this.actions.removeQueueStep(event.stepId);
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
  private pushSystemText(text: string, timestamp: string): void {
    this.builder.pushSystemMessage(text, new Date(timestamp).getTime() || Date.now());
    this.flushBlocks();
  }

  private formatStepBoundaryLabel(stepType: string, stepTitle: string): string {
    return `${stepType.toUpperCase()} · ${stepTitle}`;
  }

  /** Route subprocess output: stderr → system text, raw → passthrough, formatted → NDJSON pipeline. */
  private handleSubprocessOutput(
    stream: "stdout" | "stderr",
    data: string,
    timestamp: string,
    engineId?: string,
  ): void {
    // stderr goes through the structured pipeline as text blocks
    if (stream === "stderr") {
      this.pushSystemText(data, timestamp);
      return;
    }

    // Raw mode: pass through without parsing
    if (this._rawMode) {
      this.actions.appendOutput({ stream, data, timestamp });
      return;
    }

    // Formatted mode: feed to structured pipeline
    // Update engine ID for event routing
    if (engineId !== undefined) {
      this.currentEngineId = engineId;
    }

    // Feed chunk to NDJSONParser (handles line buffering, ANSI stripping,
    // CRLF normalization, garbage-prefix extraction)
    this.ndjsonParser.write(data);

    // Immediate flush if builder has changes (responsive for small batches)
    this.flushBlocks();
  }

  /**
   * Flush builder blocks to the store if the builder has pending changes.
   */
  private flushBlocks(): void {
    if (this.builder.hasChanged()) {
      this.actions.setOutputBlocks(this.builder.getBlocks());
    }
  }

}

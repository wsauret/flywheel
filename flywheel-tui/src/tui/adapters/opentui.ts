/**
 * OpenTUI Adapter — translates FlywheelEvent → session store entry updates.
 *
 * Pipeline: subprocess stdout → NDJSONParser → StructuredEventParser
 *   → StructuredOutputBuilder → updateEntry({ outputBlocks })
 *
 * Dispatcher/evaluator NDJSON handling is delegated to NdjsonPipeline.
 */

import { assertNever, type FlywheelEvent } from "../../infra/events.js";
import { BaseEventConsumer } from "../../infra/base-event-consumer";
import type { WorkflowSessionEntry, SessionEntryBase } from "../../orchestration/session-store-types";
import { createOutputSession, type OutputSession } from "../../orchestration/output-session.js";
import { StructuredOutputBuilder } from "../../infra/output/structured-output-builder.js";
import { NdjsonPipeline } from "./ndjson-pipeline.js";
import { createNoopEmit } from "../../infra/event-bus";
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

  // ── OutputSession (replaces OutputPipeline) ──

  private outputSession: OutputSession;

  /** Synthetic thinking timer for engines that batch thinking blocks. */
  private syntheticThinkingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly syntheticThinkingMs: number | undefined;
  private disconnected = false;
  /** Unified modelActivity writer — clears synthetic timer and forwards to store. */
  private wrappedUpdateEntry!: (patch: Partial<SessionEntryBase>) => void;

  /** Dispatcher/evaluator NDJSON pipeline (block tracking + activity extraction). */
  private ndjsonPipeline: NdjsonPipeline;

  constructor(options: OpenTUIAdapterOptions) {
    super();
    this.updateEntry = options.updateEntry;
    this.syntheticThinkingMs = options.engineMetadata?.syntheticThinkingMs;

    // Shared builder — used by both OutputSession and NdjsonPipeline so
    // dispatcher/evaluator writes appear in the same block stream.
    const builder = new StructuredOutputBuilder();

    // Wrap updateEntry to intercept modelActivity changes for the synthetic
    // thinking timer (engine-specific: batches tool_executing/generating into
    // a delayed "thinking" state). All modelActivity writes go through this
    // wrapper — including queue:completed/failed — so the timer is always cleared.
    this.wrappedUpdateEntry = (patch: Partial<SessionEntryBase>) => {
      if (patch.modelActivity !== undefined) {
        if (this.syntheticThinkingTimer) {
          clearTimeout(this.syntheticThinkingTimer);
          this.syntheticThinkingTimer = null;
        }
        if (
          this.syntheticThinkingMs !== undefined &&
          (patch.modelActivity === "tool_executing" || patch.modelActivity === "generating")
        ) {
          this.syntheticThinkingTimer = setTimeout(() => {
            this.syntheticThinkingTimer = null;
            if (this.disconnected) return;
            this.updateEntry({ modelActivity: "thinking" });
          }, this.syntheticThinkingMs);
        }
      }
      this.updateEntry(patch as Partial<WorkflowSessionEntry>);
    };

    // Workflow mode: subprocess:ndjson events are already emitted by
    // subprocess-callback.ts — supply a no-op emit to avoid duplicates.
    const noopEmit = createNoopEmit();

    this.outputSession = createOutputSession({
      updateEntry: this.wrappedUpdateEntry,
      emit: noopEmit,
      builder,
    });

    // Initialize dispatcher/evaluator NDJSON pipeline with the shared builder
    this.ndjsonPipeline = new NdjsonPipeline(builder);
  }

  /**
   * Clean up intervals on disconnect.
   * Must be called after subprocess exits.
   */
  override disconnect(): void {
    this.disconnected = true;
    super.disconnect();
    if (this.syntheticThinkingTimer !== null) {
      clearTimeout(this.syntheticThinkingTimer);
      this.syntheticThinkingTimer = null;
    }
    this.outputSession.dispose();
  }

  protected handleEvent(event: FlywheelEvent): void {
    switch (event.type) {
      case "subprocess:output":
        // Write output BEFORE resolving pending messages — resolvePendingMessages
        // moves resolved messages to the end of the block array, so the triggering
        // output must already be appended for the user message to appear after it.
        if (event.stream === "stderr") {
          this.outputSession.writeStderr(event.data, event.timestamp);
        } else {
          this.outputSession.writeStdout(event.data, event.engineId);
        }
        this.outputSession.resolvePendingMessages();
        break;

      case "subprocess:spawned":
        log.debug(`Subprocess spawned for step ${event.stepIndex}`, { step: event.stepIndex });
        this.outputSession.notifySpawned(event.timestamp);
        break;

      case "dispatcher:invoked":
        this.ndjsonPipeline.startDispatcher();
        break;

      case "dispatcher:completed": {
        const warnings = event.decision.warnings;
        const warningText = warnings && warnings.length > 0
          ? ` (${warnings.length} warning${warnings.length > 1 ? "s" : ""})`
          : "";
        this.ndjsonPipeline.completeDispatcher(`Prompt ready${warningText}`);
        break;
      }

      case "dispatcher:failed":
        this.ndjsonPipeline.failDispatcher(event.reason);
        break;

      case "evaluator:invoked":
        this.ndjsonPipeline.startEvaluator();
        break;

      case "evaluator:completed": {
        const verdict = event.result.passed ? "Passed" : "Needs revision";
        const reasoning = event.result.reasoning ? ` \u2014 ${event.result.reasoning}` : "";
        this.ndjsonPipeline.completeEvaluator(`${verdict}${reasoning}`);
        break;
      }

      case "evaluator:failed":
        this.ndjsonPipeline.failEvaluator(event.reason);
        break;

      case "evaluator:revision-requested":
        this.ndjsonPipeline.completeEvaluator(`Needs revision (attempt ${event.revisionAttempt}/${event.maxRevisions})`);
        break;

      case "budget:metrics-changed":
        // No TUI rendering — metrics flow to the store via wireSessionSubscribers,
        // and the TUI reads them reactively from the store entry.
        break;

      case "budget:exhausted":
        log.warn("Budget exhausted", { workflowId: event.workflowId, reason: event.reason });
        this.outputSession.pushSystemMessage(`\u26a0 Budget exhausted: ${event.reason}\n`, event.timestamp);
        this.outputSession.flush();
        break;

      case "subprocess:injected":
        log.info("Subprocess stdin injected", { workflowId: event.workflowId, messageLength: event.message.length, pending: event.pending });
        this.outputSession.notifyInjected(event.message, event.timestamp, event.pending, event.origin === "system");
        break;

      case "dispatcher:output":
        if (event.stream === "stdout") {
          this.ndjsonPipeline.dispatcherParser.write(event.data);
        }
        break;

      case "evaluator:output":
        if (event.stream === "stdout") {
          this.ndjsonPipeline.evaluatorParser.write(event.data);
        }
        break;

      case "queue:initialized":
        log.info("Queue initialized", { workflowId: event.workflowId, steps: event.stepIds.length });
        break;

      case "queue:completed":
        log.info("Queue completed", { workflowId: event.workflowId, stepsCompleted: event.stepsCompleted });
        this.outputSession.resolvePendingMessages();
        this.outputSession.flush();
        this.wrappedUpdateEntry({ modelActivity: "idle" });
        break;

      case "queue:failed":
        log.warn("Queue failed", { workflowId: event.workflowId, reason: event.reason, stepsCompleted: event.stepsCompleted });
        this.outputSession.resolvePendingMessages();
        this.outputSession.flush();
        this.wrappedUpdateEntry({ modelActivity: "idle" });
        break;

      case "queue:step-started":
        log.info("Queue step started", { workflowId: event.workflowId, stepId: event.stepId, stepType: event.stepType, stepTitle: event.stepTitle });
        this.outputSession.resetTracking();
        // Only emit a step boundary separator when there are prior blocks —
        // the first step has nothing above it to separate from.
        if (this.outputSession.getBlocks().length > 0) {
          this.outputSession.pushSystemMessage(
            `${STEP_BOUNDARY_PREFIX} ${this.formatStepBoundaryLabel(event.stepType, event.stepTitle)}\n`,
            event.timestamp,
          );
          this.outputSession.flush();
        }
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

  private formatStepBoundaryLabel(stepType: string, stepTitle: string): string {
    return `${stepType.toUpperCase()} · ${stepTitle}`;
  }

}

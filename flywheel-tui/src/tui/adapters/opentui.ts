import type { FlywheelEvent } from "../../infra/events.js";
import type { EventBus, Unsubscribe } from "../../infra/event-bus.js";
import type { WorkflowSessionEntry, SessionEntryBase } from "../../orchestration/session-store-types.js";
import { createOutputSession, type OutputSession } from "../../orchestration/output-session.js";
import { StructuredOutputBuilder } from "../../infra/output/structured-output-builder.js";
import { NdjsonPipeline } from "./ndjson-pipeline.js";
import { createNoopEmit } from "../../infra/event-bus.js";
import { Log } from "../../infra/log.js";

const STEP_BOUNDARY_PREFIX = "[step-boundary]";

interface OpenTUIAdapterOptions {
  updateEntry: (patch: Partial<WorkflowSessionEntry>) => void;
  /** Engine metadata — used to configure engine-specific adapter behaviour (e.g. synthetic thinking timer). */
  engineMetadata?: import("../../orchestration/engines/core/types").EngineMetadata;
}

const log = Log.create({ service: "opentui-adapter" });

export class OpenTUIAdapter {
  private eventBus: EventBus | null = null;
  private unsubscribe: Unsubscribe | null = null;
  private updateEntry: (patch: Partial<WorkflowSessionEntry>) => void;
  private outputSession: OutputSession;
  private syntheticThinkingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly syntheticThinkingMs: number | undefined;
  private disconnected = false;
  private wrappedUpdateEntry!: (patch: Partial<SessionEntryBase>) => void;
  private ndjsonPipeline: NdjsonPipeline;

  constructor(options: OpenTUIAdapterOptions) {
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

    // Workflow mode: engine:ndjson events are already emitted by
    // worker-callback.ts — supply a no-op emit to avoid duplicates.
    const noopEmit = createNoopEmit();

    this.outputSession = createOutputSession({
      updateEntry: this.wrappedUpdateEntry,
      emit: noopEmit,
      builder,
    });

    this.ndjsonPipeline = new NdjsonPipeline(builder);
  }

  connect(eventBus: EventBus): void {
    if (this.eventBus) this.disconnect();
    this.eventBus = eventBus;
    this.unsubscribe = eventBus.subscribe((event) => this.handleEvent(event));
  }

  disconnect(): void {
    this.disconnected = true;
    if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
    this.eventBus = null;
    if (this.syntheticThinkingTimer !== null) {
      clearTimeout(this.syntheticThinkingTimer);
      this.syntheticThinkingTimer = null;
    }
    this.outputSession.dispose();
  }

  answerQuestion(toolUseId: string, answers: Record<string, string>): void {
    this.outputSession.answerQuestion(toolUseId, answers);
  }

  cancelQuestion(toolUseId: string): void {
    this.outputSession.cancelQuestion(toolUseId);
  }

  // Why switch, not a handler map (like HeadlessAdapter): the TUI handler logic
  // varies per event — ordering constraints, multi-method calls, pipeline routing.
  // A map would require `any`-typed event params (losing discriminated union narrowing)
  // with no reduction in per-case complexity. The default throws for exhaustiveness.
  private handleEvent(event: FlywheelEvent): void {
    switch (event.type) {
      case "engine:output":
        // Write output BEFORE draining — drained messages reposition to the
        // end of the block array, so the triggering output must already be
        // appended for the user message to appear after it.
        if (event.stream === "stderr") {
          this.outputSession.writeStderr(event.data, event.timestamp);
        } else {
          this.outputSession.writeStdout(event.data);
        }
        this.outputSession.drainQueued();
        break;

      case "engine:started":
        log.debug(`Engine started for step ${event.stepIndex}`, { step: event.stepIndex });
        this.outputSession.notifySpawned(event.timestamp);
        break;

      case "dispatcher:invoked":
        this.ndjsonPipeline.startDispatcher();
        this.outputSession.notifySpawned(event.timestamp);
        break;

      case "dispatcher:completed":
        this.ndjsonPipeline.completeDispatcher("Prompt ready");
        break;

      case "dispatcher:failed":
        this.ndjsonPipeline.failDispatcher(event.reason);
        break;

      case "dispatcher:ndjson":
        this.ndjsonPipeline.feedDispatcherEvent(event.ndjsonEvent);
        break;

      case "evaluator:invoked":
        this.ndjsonPipeline.startEvaluator();
        this.outputSession.notifySpawned(event.timestamp);
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

      case "evaluator:ndjson":
        this.ndjsonPipeline.feedEvaluatorEvent(event.ndjsonEvent);
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

      case "engine:injected":
        log.info("Engine message injected", { workflowId: event.workflowId, messageLength: event.message.length, pending: event.pending });
        this.outputSession.pushUserMessage(event.message, event.timestamp, { queued: event.pending, injected: event.origin === "system" });
        break;

      case "queue:initialized":
        log.info("Queue initialized", { workflowId: event.workflowId, steps: event.stepIds.length });
        break;

      // Why explicit idle on queue:completed/failed: these are lifecycle events.
      // The builder retains its last activity; only the queue knows execution ended.
      case "queue:completed":
        log.info("Queue completed", { workflowId: event.workflowId, stepsCompleted: event.stepsCompleted });
        this.outputSession.drainQueued();
        this.outputSession.resetActivity();
        this.outputSession.flush();
        break;

      case "queue:failed":
        log.warn("Queue failed", { workflowId: event.workflowId, reason: event.reason, stepsCompleted: event.stepsCompleted });
        this.outputSession.drainQueued();
        this.outputSession.resetActivity(event.finalStatus === "paused" ? "paused" : "completed");
        this.outputSession.flush();
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
        break;

      case "queue:step-failed":
        log.warn("Queue step failed", { workflowId: event.workflowId, stepId: event.stepId, stepType: event.stepType, reason: event.reason });
        break;

      case "engine:ndjson":
        if (event.ndjsonEvent.type === "user") {
          this.outputSession.drainQueued();
        }
        break;

      // Trace events — handled by TraceCollector, no TUI rendering needed
      case "trace:tool-started":
      case "trace:tool-completed":
      case "trace:subagent-started":
      case "trace:subagent-completed":
        break;

      default: {
        const _: never = event;
        throw new Error(`Unhandled event type: ${(_ as FlywheelEvent).type}`);
      }
    }
  }

  private formatStepBoundaryLabel(stepType: string, stepTitle: string): string {
    return `${stepType.toUpperCase()} · ${stepTitle}`;
  }

}

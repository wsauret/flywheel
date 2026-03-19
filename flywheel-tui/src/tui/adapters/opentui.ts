/**
 * OpenTUI Adapter
 *
 * Translates FlywheelEvent → UIActions (store mutations).
 * Uses assertNever for exhaustive switch — adding a new event type
 * without a case here causes a compile-time error.
 *
 * Structured output pipeline:
 *   worker stdout chunks → NDJSONParser (line buffering + JSON parsing)
 *     → StructuredEventParser (engine routing + format normalization)
 *       → SubagentTraceParser (agent lifecycle tracking)
 *       → StructuredOutputBuilder (block accumulation)
 *         → setOutputBlocks (batched flush)
 *
 * Timer service integration: converts phase indexes to string IDs
 * ("phase-0", "phase-1", …) for the agent-based timer API.
 */

import type { FlywheelEvent } from "../../events/types";
import { assertNever } from "../../events/types";
import type { AdapterType } from "./types";
import { BaseUIAdapter } from "./base";
import type { UIActions } from "../routes/work/context/ui-state/types";
import { timerService } from "../shared/services/timer";
import { extractDisplayText } from "./output-formatter";
import { NDJSONParser } from "../../worker/ndjson-parser";
import { SubagentTraceParser } from "./subagent-tracing/parser";
import { StructuredOutputBuilder } from "./structured-output-builder";
import { StructuredEventParser } from "./structured-event-parser";

/** Flush interval for batched block updates (ms). */
const FLUSH_INTERVAL_MS = 16;

export interface OpenTUIAdapterOptions {
  actions: UIActions;
}

export class OpenTUIAdapter extends BaseUIAdapter {
  readonly adapterType: AdapterType = "opentui";
  private actions: UIActions;

  /** When true, pass raw output without NDJSON parsing */
  private _rawMode = false;

  /** When true, we're inside a multi-stage pipeline — skip timer reset on workflow:started */
  private _pipelineMode = false;

  /** When true, pipeline:failed skips setError (user-initiated pause). */
  public suppressPipelineError = false;

  /** Elapsed time (ms) for each completed pipeline stage, recorded at stage transitions */
  private _stageTimings: number[] = [];

  /** Timestamp when the current pipeline stage started (for computing per-stage elapsed) */
  private _stageStartedAt: number = 0;

  /** Current engine ID for routing events. Updated per worker:output event. */
  private currentEngineId: string | undefined;

  // ── Structured pipeline components ──

  private ndjsonParser: NDJSONParser;
  private traceParser: SubagentTraceParser;
  private builder: StructuredOutputBuilder;
  private eventParser: StructuredEventParser;

  /** Interval handle for batched flush. */
  private flushInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: OpenTUIAdapterOptions) {
    super();
    this.actions = options.actions;

    // Initialize structured pipeline
    this.traceParser = new SubagentTraceParser();
    this.builder = new StructuredOutputBuilder();
    this.eventParser = new StructuredEventParser({
      traceParser: this.traceParser,
      builder: this.builder,
    });
    this.ndjsonParser = new NDJSONParser();

    // Wire NDJSONParser events to StructuredEventParser
    this.ndjsonParser.onEvent = (event) => {
      this.eventParser.dispatch(event, this.currentEngineId);
    };

    // Raw text lines (non-JSON) → push as text blocks
    this.ndjsonParser.onRawText = (text) => {
      this.builder.pushText(text + "\n", Date.now());
    };

    // Start batched flush interval
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

  /** Check if we're inside a multi-stage pipeline. */
  get isPipelineMode(): boolean {
    return this._pipelineMode;
  }

  /** Per-stage elapsed times (ms) recorded at each stage transition. */
  get pipelineStageTimings(): number[] {
    return this._stageTimings;
  }

  /** Clean up interval on disconnect. */
  override disconnect(): void {
    super.disconnect();
    if (this.flushInterval !== null) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }

  protected handleEvent(event: FlywheelEvent): void {
    switch (event.type) {
      case "workflow:started":
        if (!this._pipelineMode) {
          // Standalone workflow: full reset — fresh timer, fresh store.
          timerService.reset();
          timerService.start();
          this.actions.startWorkflow(event.planPath);
        } else {
          // Pipeline mode: new stage starting within an ongoing session.
          // The output log is continuous — only update metadata, don't wipe blocks.
          this.actions.continueStage(event.planPath);
        }
        break;

      case "workflow:completed":
        if (!this._pipelineMode) {
          timerService.stop();
        }
        // Final flush before completing
        this.flushBlocks();
        this.actions.stopWorkflow("completed");
        break;

      case "workflow:failed":
        if (!this._pipelineMode) {
          timerService.stop();
        }
        this.flushBlocks();
        if (!this.suppressPipelineError) {
          this.actions.setError(event.reason);
        }
        break;

      case "workflow:interrupted":
        if (!this._pipelineMode) {
          timerService.stop();
        }
        this.flushBlocks();
        this.actions.stopWorkflow("interrupted");
        break;

      case "phase:started": {
        // Dynamic phase discovery: if phase doesn't exist yet, add it
        if (event.phaseIndex >= this.actions.getState().phases.length) {
          this.actions.addPhase({
            index: event.phaseIndex,
            name: event.phaseName,
          });
        }

        // Reset worker-level tracking (agent IDs, tool-use mappings, partial buffers).
        // These are per-worker-process and invalid across phase boundaries.
        this.traceParser.reset();
        this.eventParser.reset();
        this.ndjsonParser.flush();

        if (this._pipelineMode) {
          // Pipeline mode: keep accumulated blocks, reset only tracking state.
          // The output log is continuous across stages/phases.
          this.builder.resetTracking();
        } else {
          // Standalone: each phase starts with a clean output slate.
          this.builder.reset();
          this.actions.setOutputBlocks(this.builder.getBlocks());
        }

        timerService.registerAgent(`phase-${event.phaseIndex}`);
        this.actions.startPhase(event.phaseIndex, event.phaseName);
        break;
      }

      case "phase:completed":
        // Final flush for this phase
        this.ndjsonParser.flush();
        this.flushBlocks();
        timerService.completeAgent(`phase-${event.phaseIndex}`);
        this.actions.completePhase(event.phaseIndex);
        break;

      case "phase:failed":
        this.ndjsonParser.flush();
        this.flushBlocks();
        timerService.completeAgent(`phase-${event.phaseIndex}`);
        this.actions.failPhase(event.phaseIndex, event.reason);
        break;

      case "worker:output":
        this.handleWorkerOutput(event.stream, event.data, event.timestamp, event.engineId);
        break;

      case "worker:retrying":
        this.pushSystemText(`↻ Retrying (${event.attempt}/${event.maxAttempts}): ${event.reason}\n`, event.timestamp);
        break;

      case "approval:requested":
        this.actions.setApprovalPending(event.description);
        break;

      case "approval:received":
        this.actions.clearApproval();
        break;

      // Worker lifecycle events
      case "worker:spawned":
        this.pushSystemText(`◉ Worker spawned for step ${event.stepIndex}\n`, event.timestamp);
        break;

      case "worker:completed":
        this.pushSystemText(`◉ Worker finished\n`, event.timestamp);
        break;

      case "worker:failed":
        this.pushSystemText(`◉ Worker failed: ${event.failure.message}\n`, event.timestamp);
        break;

      // Step events
      case "step:started":
        this.pushSystemText(`▸ Step ${event.stepIndex}: ${event.description}\n`, event.timestamp);
        break;

      case "step:completed":
        this.pushSystemText(`✓ Step ${event.stepIndex} complete\n`, event.timestamp);
        break;

      case "step:failed":
        this.pushSystemText(`✗ Step ${event.stepIndex} failed: ${event.reason}\n`, event.timestamp);
        break;

      // Dispatcher events
      case "dispatcher:invoked":
        this.pushSystemText(`⚡ Dispatcher: crafting prompt for step ${event.stepIndex}...\n`, event.timestamp);
        break;

      case "dispatcher:completed":
        this.pushSystemText(`⚡ Dispatcher: prompt ready\n`, event.timestamp);
        break;

      case "dispatcher:failed":
        this.pushSystemText(`⚠ Dispatcher failed: ${event.reason}. Using static template.\n`, event.timestamp);
        break;

      // Evaluator events
      case "evaluator:invoked":
        this.pushSystemText(`🔍 Evaluator: checking output quality...\n`, event.timestamp);
        break;

      case "evaluator:completed":
        this.pushSystemText(`🔍 Evaluator: ${event.result.passed ? "passed" : "needs revision"} — ${event.result.reasoning}\n`, event.timestamp);
        break;

      case "evaluator:failed":
        this.pushSystemText(`⚠ Evaluator failed: ${event.reason}. Skipping.\n`, event.timestamp);
        break;

      // Question events — handled by QuestionPrompt component, not adapter
      case "question:asked":
      case "question:replied":
      case "question:rejected":
        break;

      // Pipeline events
      case "pipeline:started":
        this._pipelineMode = true;
        this._stageTimings = [];
        this._stageStartedAt = Date.now();
        // Start the session timer once at pipeline start (not per-stage).
        timerService.reset();
        timerService.start();
        this.pushSystemText(`▶ Pipeline started: ${event.stages.join(" → ")}\n`, event.timestamp);
        break;
      case "pipeline:stage-transition": {
        const now = Date.now();
        if (this._stageStartedAt > 0) {
          this._stageTimings.push(now - this._stageStartedAt);
        }
        this._stageStartedAt = now;
        this.pushSystemText(`◈ ${event.from} complete. Starting ${event.to}...\n`, event.timestamp);
        break;
      }
      case "pipeline:completed":
        this._pipelineMode = false;
        timerService.stop();
        this.pushSystemText(`✓ Pipeline complete (${event.stagesCompleted} stages)\n`, event.timestamp);
        break;
      case "pipeline:failed":
        this._pipelineMode = false;
        timerService.stop();
        this.pushSystemText(`✗ Pipeline failed: ${event.reason}\n`, event.timestamp);
        if (!this.suppressPipelineError) {
          this.actions.setError(event.reason);
        }
        break;

      default:
        assertNever(event);
    }
  }

  /**
   * Push a system message through the structured block pipeline and flush.
   * Used for lifecycle events (worker:spawned, step:started, etc.) that
   * previously went through appendOutput.
   */
  private pushSystemText(text: string, timestamp: string): void {
    this.builder.pushText(text, new Date(timestamp).getTime() || Date.now());
    this.flushBlocks();
  }

  /**
   * Handle worker output chunks.
   * - stderr: push through builder as text blocks (structured pipeline)
   * - raw mode: pass through to appendOutput (bypass structured pipeline)
   * - formatted mode: feed to NDJSONParser → structured pipeline → setOutputBlocks
   */
  private handleWorkerOutput(
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

/** Factory function for creating an OpenTUI adapter */
export function createOpenTUIAdapter(actions: UIActions): OpenTUIAdapter {
  return new OpenTUIAdapter({ actions });
}

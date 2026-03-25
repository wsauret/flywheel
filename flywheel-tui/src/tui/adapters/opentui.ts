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
import { TimerService } from "../shared/services/timer";
import { extractDisplayText } from "./output-formatter";
import { NDJSONParser } from "../../worker/ndjson-parser";
import { SubagentTraceParser } from "./subagent-tracing/parser";
import { StructuredOutputBuilder } from "./structured-output-builder";
import { StructuredEventParser } from "./structured-event-parser";
import { Log } from "../../utils/log";

/** Flush interval for batched block updates (ms). */
const FLUSH_INTERVAL_MS = 16;

/** Timeout (ms) after which an agent with no activity is auto-completed. */
const AGENT_STALE_TIMEOUT_MS = 30_000;

export interface OpenTUIAdapterOptions {
  actions: UIActions;
  timer?: TimerService;
}

const log = Log.create({ service: "opentui-adapter" });

export class OpenTUIAdapter extends BaseUIAdapter {
  readonly adapterType: AdapterType = "opentui";
  private actions: UIActions;
  /** Per-session timer instance. Injected via constructor; falls back to a private instance. */
  readonly timer: TimerService;

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

  /** Current stage label for routing phase events to the correct StageGroup. */
  private _currentStageLabel: string = "work";

  /** Current engine ID for routing events. Updated per worker:output event. */
  private currentEngineId: string | undefined;

  // ── Structured pipeline components ──

  private ndjsonParser: NDJSONParser;
  private traceParser: SubagentTraceParser;
  private builder: StructuredOutputBuilder;
  private eventParser: StructuredEventParser;

  /** Interval handle for batched flush. */
  private flushInterval: ReturnType<typeof setInterval> | null = null;

  /** Tracks last-activity timestamp per active agent for stale detection. */
  private agentActivityMap = new Map<string, number>();

  /** Tracks spawn timestamp per agent for accurate duration on stale completion. */
  private agentSpawnTimeMap = new Map<string, number>();

  /** Interval handle for stale agent checks (1s). */
  private staleCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: OpenTUIAdapterOptions) {
    super();
    this.actions = options.actions;
    this.timer = options.timer ?? new TimerService();

    // Initialize structured pipeline
    this.traceParser = new SubagentTraceParser();
    this.builder = new StructuredOutputBuilder();
    this.eventParser = new StructuredEventParser({
      traceParser: this.traceParser,
      builder: this.builder,
    });
    this.ndjsonParser = new NDJSONParser();

    // Wire builder callbacks for stale agent tracking
    this.builder.onAgentLifecycle = (type, id) => {
      if (type === "start") {
        const now = Date.now();
        this.agentActivityMap.set(id, now);
        this.agentSpawnTimeMap.set(id, now);
      } else {
        // "complete" or "error" — agent is no longer active
        this.agentActivityMap.delete(id);
        this.agentSpawnTimeMap.delete(id);
      }
    };
    this.builder.onAgentActivity = (id) => {
      if (this.agentActivityMap.has(id)) {
        this.agentActivityMap.set(id, Date.now());
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

    // Start batched flush interval
    this.flushInterval = setInterval(() => {
      this.flushBlocks();
    }, FLUSH_INTERVAL_MS);

    // Start stale agent check interval (1s)
    this.staleCheckInterval = setInterval(() => {
      this.checkStaleAgents();
    }, 1000);
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

  /** Clean up intervals on disconnect. */
  override disconnect(): void {
    super.disconnect();
    if (this.flushInterval !== null) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    if (this.staleCheckInterval !== null) {
      clearInterval(this.staleCheckInterval);
      this.staleCheckInterval = null;
    }
  }

  /**
   * Suspend the periodic flush interval.
   * Called when a session is backgrounded to avoid wasting ticks on a non-viewed session.
   */
  pauseFlush(): void {
    if (this.flushInterval !== null) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }

  /**
   * Resume the periodic flush interval.
   * Called when a session is brought back to the foreground.
   */
  resumeFlush(): void {
    if (this.flushInterval !== null) return; // already running
    this.flushInterval = setInterval(() => {
      this.flushBlocks();
    }, FLUSH_INTERVAL_MS);
  }

  protected handleEvent(event: FlywheelEvent): void {
    switch (event.type) {
      case "workflow:started":
        if (!this._pipelineMode) {
          // Standalone workflow: full reset — fresh timer, fresh store.
          this.timer.reset();
          this.timer.start();
          this.actions.startWorkflow(event.planPath);
          // Create a single "work" stage for standalone mode
          this._currentStageLabel = "work";
          this.actions.addStage("work");
          this.actions.startStage("work");
        } else {
          // Pipeline mode: new stage starting within an ongoing session.
          // The output log is continuous — only update metadata, don't wipe blocks.
          this.actions.continueStage(event.planPath);
          // Start the current stage (already created by pipeline:started)
          this.actions.startStage(this._currentStageLabel);
        }
        break;

      case "workflow:completed":
        if (!this._pipelineMode) {
          this.timer.stop();
        } else {
          // Pipeline mode: mark the current stage as completed immediately
          // so the spinner turns green before the next stage-transition event.
          this.actions.completeStage(this._currentStageLabel);
        }
        // Final flush before completing
        this.flushBlocks();
        this.actions.stopWorkflow("completed");
        break;

      case "workflow:failed":
        if (!this._pipelineMode) {
          this.timer.stop();
        }
        this.flushBlocks();
        if (!this.suppressPipelineError) {
          this.actions.setError(event.reason);
        }
        break;

      case "workflow:interrupted":
        if (!this._pipelineMode) {
          this.timer.stop();
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

        this.timer.registerAgent(`phase-${event.phaseIndex}`);
        this.actions.startPhase(event.phaseIndex, event.phaseName);

        // Also populate stage-scoped phases
        this.actions.startPhaseInStage(this._currentStageLabel, event.phaseIndex, event.phaseName);
        break;
      }

      case "phase:completed":
        // Final flush for this phase
        this.ndjsonParser.flush();
        this.flushBlocks();
        this.timer.completeAgent(`phase-${event.phaseIndex}`);
        this.actions.completePhase(event.phaseIndex);
        this.actions.completePhaseInStage(this._currentStageLabel, event.phaseIndex);
        break;

      case "phase:failed":
        this.ndjsonParser.flush();
        this.flushBlocks();
        this.timer.completeAgent(`phase-${event.phaseIndex}`);
        this.actions.failPhase(event.phaseIndex, event.reason);
        this.actions.failPhaseInStage(this._currentStageLabel, event.phaseIndex, event.reason);
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

      // Worker lifecycle events — spawned/completed are suppressed from TUI
      // output (noise) but logged for debugging. Failures remain visible.
      case "worker:spawned":
        log.debug(`Worker spawned for step ${event.stepIndex}`, { step: event.stepIndex });
        break;

      case "worker:completed":
        log.debug("Worker finished");
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
        this.pushSystemText(`⚡ Dispatcher: analyzing phase and crafting worker prompt...\n`, event.timestamp);
        break;

      case "dispatcher:completed": {
        const warnings = event.decision.warnings;
        const warningText = warnings && warnings.length > 0
          ? ` (${warnings.length} warning${warnings.length > 1 ? "s" : ""})`
          : "";
        this.pushSystemText(`⚡ Dispatcher: prompt ready${warningText} — launching worker\n`, event.timestamp);
        break;
      }

      case "dispatcher:failed":
        this.pushSystemText(`⚠ Dispatcher unavailable: ${event.reason}. Using static prompt.\n`, event.timestamp);
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

      case "evaluator:revision-requested":
        this.pushSystemText(
          `🔄 Needs revision (attempt ${event.revisionAttempt}/${event.maxRevisions}) — re-running worker...\n`,
          new Date(event.timestamp).toISOString(),
        );
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
        this.timer.reset();
        this.timer.start();
        // Pre-create all stage groups with pending status
        for (const stage of event.stages) {
          this.actions.addStage(stage);
        }
        // Set the first stage as current (will be started on workflow:started)
        this._currentStageLabel = event.stages[0] ?? "work";
        this.pushSystemText(`▶ Pipeline started: ${event.stages.join(" → ")}\n`, event.timestamp);
        break;
      case "pipeline:stage-transition": {
        const now = Date.now();
        if (this._stageStartedAt > 0) {
          this._stageTimings.push(now - this._stageStartedAt);
        }
        this._stageStartedAt = now;
        // Complete the outgoing stage and buffer the incoming stage label
        this.actions.completeStage(event.from);
        this._currentStageLabel = event.to;
        this.pushSystemText(`◈ ${event.from} complete. Starting ${event.to}...\n`, event.timestamp);
        break;
      }
      case "pipeline:completed":
        // Complete the final stage
        this.actions.completeStage(this._currentStageLabel);
        this._pipelineMode = false;
        this.timer.stop();
        this.pushSystemText(`✓ Pipeline complete (${event.stagesCompleted} stages)\n`, event.timestamp);
        break;
      case "pipeline:failed":
        // Fail the current stage
        this.actions.failStage(this._currentStageLabel);
        this._pipelineMode = false;
        this.timer.stop();
        this.pushSystemText(`✗ Pipeline failed: ${event.reason}\n`, event.timestamp);
        if (!this.suppressPipelineError) {
          this.actions.setError(event.reason);
        }
        break;

      // Budget events
      case "budget:warning":
        log.info("Budget warning", { metric: event.metric, used: event.used, limit: event.limit, remaining: event.remaining });
        break;

      case "budget:exhausted":
        log.warn("Budget exhausted", { workflowId: event.workflowId, reason: event.reason });
        this.pushSystemText(`⚠ Budget exhausted: ${event.reason}\n`, event.timestamp);
        break;

      // Worker injection events
      case "worker:injected":
        log.info("Worker stdin injected", { workflowId: event.workflowId, messageLength: event.message.length });
        this.pushSystemText(`↳ Injected: ${event.message.slice(0, 100)}${event.message.length > 100 ? "..." : ""}\n`, event.timestamp);
        break;

      default:
        assertNever(event);
    }
  }

  /**
   * Push a system message through the structured block pipeline and flush.
   * Used for lifecycle events (step:started, worker:failed, etc.) that
   * are user-relevant. Produces SystemBlock objects.
   *
   * Timestamp conversion: `new Date(timestamp).getTime()` handles ISO strings;
   * falls back to `Date.now()` if parsing returns NaN (e.g., empty string).
   */
  private pushSystemText(text: string, timestamp: string): void {
    this.builder.pushSystemMessage(text, new Date(timestamp).getTime() || Date.now());
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

  /**
   * Auto-complete agents that haven't had any activity for AGENT_STALE_TIMEOUT_MS.
   * Runs on a 1-second interval, separate from the 16ms flush cycle.
   * Stale agents are completed normally (not errored) since they likely
   * did finish — we just missed the completion signal.
   */
  private checkStaleAgents(): void {
    const now = Date.now();
    for (const [id, lastActivity] of this.agentActivityMap) {
      if (now - lastActivity > AGENT_STALE_TIMEOUT_MS) {
        // Compute elapsed time from when the agent was first seen (spawned),
        // not from last activity, so the duration is meaningful.
        const spawnedAt = this.agentSpawnTimeMap.get(id) ?? lastActivity;
        const elapsed = now - spawnedAt;
        this.builder.completeAgent(id, elapsed, 0);
        this.agentActivityMap.delete(id);
        this.agentSpawnTimeMap.delete(id);
        this.flushBlocks();
      }
    }
  }
}

/** Factory function for creating an OpenTUI adapter */
export function createOpenTUIAdapter(actions: UIActions, timer?: TimerService): OpenTUIAdapter {
  return new OpenTUIAdapter({ actions, timer });
}

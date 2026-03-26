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

  /** When true, queue:failed skips setError (user-initiated pause). */
  public suppressPipelineError = false;

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

  // ── Dispatcher/evaluator agent block tracking ──

  private _dispatcherBlockId: string | null = null;
  private _dispatcherStartedAt: number = 0;
  private _evaluatorBlockId: string | null = null;
  private _evaluatorStartedAt: number = 0;

  /** Separate NDJSON parsers for dispatcher/evaluator (isolate from worker pipeline). */
  private dispatcherNdjsonParser: NDJSONParser;
  private evaluatorNdjsonParser: NDJSONParser;

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

    // Dispatcher NDJSON parser — routes tool events into the dispatcher agent block
    this.dispatcherNdjsonParser = new NDJSONParser();
    this.dispatcherNdjsonParser.onEvent = (event) => {
      this.handleDispatcherNdjsonEvent(event);
    };
    this.dispatcherNdjsonParser.onRawText = () => {}; // Discard raw text from dispatcher

    // Evaluator NDJSON parser — routes tool events into the evaluator agent block
    this.evaluatorNdjsonParser = new NDJSONParser();
    this.evaluatorNdjsonParser.onEvent = (event) => {
      this.handleEvaluatorNdjsonEvent(event);
    };
    this.evaluatorNdjsonParser.onRawText = () => {}; // Discard raw text from evaluator

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
        // Full reset — fresh timer, fresh store.
        this.timer.reset();
        this.timer.start();
        this.actions.startWorkflow(event.planPath);
        this.actions.addStage("work");
        this.actions.startStage("work");
        break;

      case "workflow:completed":
        this.timer.stop();
        // Final flush before completing
        this.flushBlocks();
        this.actions.stopWorkflow("completed");
        break;

      case "workflow:failed":
        this.timer.stop();
        this.flushBlocks();
        if (!this.suppressPipelineError) {
          this.actions.setError(event.reason);
        }
        break;

      case "workflow:interrupted":
        this.timer.stop();
        this.flushBlocks();
        this.actions.stopWorkflow("interrupted");
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
      case "dispatcher:invoked": {
        const blockId = `dispatcher_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this._dispatcherBlockId = blockId;
        this._dispatcherStartedAt = Date.now();
        this.dispatcherNdjsonParser.flush();
        this.builder.startAgent(blockId, "Dispatcher", "Analyzing phase and crafting worker prompt", Date.now());
        this.flushBlocks();
        break;
      }

      case "dispatcher:completed": {
        if (this._dispatcherBlockId) {
          const elapsed = Date.now() - this._dispatcherStartedAt;
          this.dispatcherNdjsonParser.flush();
          this.builder.completeAgent(this._dispatcherBlockId, elapsed, 0);
          this._dispatcherBlockId = null;
          this.flushBlocks();
        }
        // Follow-up system message with summary (outside the agent block)
        const warnings = event.decision.warnings;
        const warningText = warnings && warnings.length > 0
          ? ` (${warnings.length} warning${warnings.length > 1 ? "s" : ""})`
          : "";
        this.pushSystemText(`⚡ Dispatcher: prompt ready${warningText} — launching worker\n`, event.timestamp);
        break;
      }

      case "dispatcher:failed": {
        if (this._dispatcherBlockId) {
          this.dispatcherNdjsonParser.flush();
          this.builder.errorAgent(this._dispatcherBlockId, event.reason);
          this._dispatcherBlockId = null;
          this.flushBlocks();
        }
        this.pushSystemText(`⚠ Dispatcher unavailable: ${event.reason}. Using static prompt.\n`, event.timestamp);
        break;
      }

      // Evaluator events
      case "evaluator:invoked": {
        const blockId = `evaluator_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this._evaluatorBlockId = blockId;
        this._evaluatorStartedAt = Date.now();
        this.evaluatorNdjsonParser.flush();
        this.builder.startAgent(blockId, "Evaluator", "Checking output quality", Date.now());
        this.flushBlocks();
        break;
      }

      case "evaluator:completed": {
        if (this._evaluatorBlockId) {
          const elapsed = Date.now() - this._evaluatorStartedAt;
          this.evaluatorNdjsonParser.flush();
          this.builder.completeAgent(this._evaluatorBlockId, elapsed, 0);
          this._evaluatorBlockId = null;
          this.flushBlocks();
        }
        // Follow-up system message with the verdict (outside the agent block)
        this.pushSystemText(
          `🔍 Evaluator: ${event.result.passed ? "passed" : "needs revision"} — ${event.result.reasoning}\n`,
          event.timestamp,
        );
        break;
      }

      case "evaluator:failed": {
        if (this._evaluatorBlockId) {
          this.evaluatorNdjsonParser.flush();
          this.builder.errorAgent(this._evaluatorBlockId, event.reason);
          this._evaluatorBlockId = null;
          this.flushBlocks();
        }
        this.pushSystemText(`⚠ Evaluator failed: ${event.reason}. Skipping.\n`, event.timestamp);
        break;
      }

      case "evaluator:revision-requested": {
        // Complete the current evaluator block first (it's done evaluating)
        if (this._evaluatorBlockId) {
          const elapsed = Date.now() - this._evaluatorStartedAt;
          this.evaluatorNdjsonParser.flush();
          this.builder.completeAgent(this._evaluatorBlockId, elapsed, 0);
          this._evaluatorBlockId = null;
          this.flushBlocks();
        }
        this.pushSystemText(
          `🔄 Needs revision (attempt ${event.revisionAttempt}/${event.maxRevisions}) — re-running worker...\n`,
          new Date(event.timestamp).toISOString(),
        );
        break;
      }

      // Question events — handled by QuestionPrompt component, not adapter
      case "question:asked":
      case "question:replied":
      case "question:rejected":
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

      // Dispatcher/evaluator output streaming events
      case "dispatcher:output":
        if (event.stream === "stdout") {
          this.dispatcherNdjsonParser.write(event.data);
          this.flushBlocks();
        }
        break;

      case "evaluator:output":
        if (event.stream === "stdout") {
          this.evaluatorNdjsonParser.write(event.data);
          this.flushBlocks();
        }
        break;

      // Sprint events
      case "sprint:started":
        this.pushSystemText(`🏃 Sprint started: ${event.taskDescription.slice(0, 100)}${event.taskDescription.length > 100 ? "..." : ""} (max ${event.maxIterations} iterations)\n`, event.timestamp);
        break;

      case "sprint:iteration-started":
        this.pushSystemText(`▸ Sprint iteration ${event.iteration}/${event.maxIterations}\n`, event.timestamp);
        break;

      case "sprint:verification-started":
        this.pushSystemText(`🔍 Running verification: ${event.scriptPath}\n`, event.timestamp);
        break;

      case "sprint:iteration-completed":
        this.pushSystemText(
          `${event.passed ? "✓" : "✗"} Iteration ${event.iteration} ${event.passed ? "passed" : "failed"}${event.reason ? `: ${event.reason}` : ""}\n`,
          event.timestamp,
        );
        break;

      case "sprint:escalated":
        this.pushSystemText(`⚠ Sprint escalating after ${event.iterationsUsed} iteration(s): ${event.reason}\n`, event.timestamp);
        break;

      case "sprint:completed":
        this.pushSystemText(
          `${event.completed ? "✓" : "○"} Sprint ${event.completed ? "completed" : "stopped"} (${event.iterationsUsed} iteration${event.iterationsUsed !== 1 ? "s" : ""})${event.escalated ? " — escalated" : ""}${event.reason ? `: ${event.reason}` : ""}\n`,
          event.timestamp,
        );
        break;

      // Queue lifecycle events — populate store with queue step display state
      case "queue:initialized":
        log.info("Queue initialized", { workflowId: event.workflowId, steps: event.stepIds.length });
        // Steps will be populated by queue:step-started events; initialize with IDs as pending
        // The shell wires queue steps from the Queue object before starting execution
        break;

      case "queue:completed":
        log.info("Queue completed", { workflowId: event.workflowId, stepsCompleted: event.stepsCompleted });
        break;

      case "queue:failed":
        log.warn("Queue failed", { workflowId: event.workflowId, reason: event.reason, stepsCompleted: event.stepsCompleted });
        break;

      // Queue step lifecycle events — update store for panel display
      case "queue:step-started":
        log.info("Queue step started", { workflowId: event.workflowId, stepId: event.stepId, stepType: event.stepType, stepTitle: event.stepTitle });
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

      // Queue mutation events — update store for dynamic insertion display
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
   * Handle NDJSON event from dispatcher subprocess.
   * Routes tool-use events as agent children; thinking text as status-only updates.
   */
  private handleDispatcherNdjsonEvent(event: import("../../worker/ndjson-parser").NDJSONEvent): void {
    if (!this._dispatcherBlockId) return;
    const activity = this.extractActivityInfo(event.data);
    if (!activity) return;

    if (activity.name === "Thinking") {
      this.builder.updateAgentLatestChild(this._dispatcherBlockId, `Thinking: ${activity.detail}`);
    } else {
      this.builder.pushToolToAgent(this._dispatcherBlockId, activity.name, activity.detail, Date.now());
    }
    this.flushBlocks();
  }

  /**
   * Handle NDJSON event from evaluator subprocess.
   * Routes tool-use events as agent children; thinking text as status-only updates.
   */
  private handleEvaluatorNdjsonEvent(event: import("../../worker/ndjson-parser").NDJSONEvent): void {
    if (!this._evaluatorBlockId) return;
    const activity = this.extractActivityInfo(event.data);
    if (!activity) return;

    if (activity.name === "Thinking") {
      this.builder.updateAgentLatestChild(this._evaluatorBlockId, `Thinking: ${activity.detail}`);
    } else {
      this.builder.pushToolToAgent(this._evaluatorBlockId, activity.name, activity.detail, Date.now());
    }
    this.flushBlocks();
  }

  /**
   * Extract activity info from a Claude NDJSON event data payload.
   * Returns tool-use info OR thinking text from assistant messages.
   * Returns null if the event contains no actionable activity.
   */
  private extractActivityInfo(data: Record<string, unknown>): { name: string; detail: string } | null {
    // Claude assistant message — content may be at data.content or data.message.content
    const content =
      (Array.isArray(data.content) ? data.content : null) ??
      (data.message && typeof data.message === "object"
        ? (Array.isArray((data.message as Record<string, unknown>).content)
            ? (data.message as Record<string, unknown>).content as unknown[]
            : null)
        : null);

    if (data.type === "assistant" && content) {
      // Prefer tool_use blocks over text/thinking blocks
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === "tool_use" && typeof block.name === "string") {
          const input = block.input as Record<string, unknown> | undefined;
          const detail = this.extractToolDetail(block.name, input);
          return { name: block.name, detail };
        }
      }
      // Fall back to thinking blocks, then text blocks
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === "thinking" && typeof block.thinking === "string") {
          const line = this.extractLastMeaningfulLine(block.thinking);
          if (line) return { name: "Thinking", detail: line };
        }
        if (block.type === "text" && typeof block.text === "string") {
          const line = this.extractLastMeaningfulLine(block.text);
          if (line) return { name: "Thinking", detail: line };
        }
      }
    }

    // Claude tool_use event (direct)
    if (data.type === "tool_use" && typeof data.name === "string") {
      const input = data.input as Record<string, unknown> | undefined;
      const detail = this.extractToolDetail(data.name, input);
      return { name: data.name, detail };
    }

    // Claude streaming content_block_delta with text_delta or thinking_delta
    if (data.type === "content_block_delta") {
      const delta = data.delta as Record<string, unknown> | undefined;
      if (delta) {
        if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          const line = this.extractLastMeaningfulLine(delta.thinking);
          if (line) return { name: "Thinking", detail: line };
        }
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          const line = this.extractLastMeaningfulLine(delta.text);
          if (line) return { name: "Thinking", detail: line };
        }
      }
    }

    return null;
  }

  /**
   * Extract the last non-empty, meaningful line from text, truncated to 80 chars.
   * Skips lines that are only whitespace or punctuation.
   */
  private extractLastMeaningfulLine(text: string): string | null {
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      // Skip empty or whitespace/punctuation-only lines
      if (trimmed.length === 0 || /^[\s\p{P}]+$/u.test(trimmed)) continue;
      return trimmed.length > 80 ? trimmed.slice(0, 77) + "..." : trimmed;
    }
    return null;
  }

  /**
   * Extract a short detail string from tool input for display.
   */
  private extractToolDetail(toolName: string, input?: Record<string, unknown>): string {
    if (!input) return "";
    // For Write/Edit tools, show the file path
    if (input.file_path && typeof input.file_path === "string") {
      return input.file_path;
    }
    // For Read tools, show the file path
    if (input.path && typeof input.path === "string") {
      return input.path;
    }
    // For Bash tools, show truncated command
    if (input.command && typeof input.command === "string") {
      const cmd = input.command as string;
      return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
    }
    return "";
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
